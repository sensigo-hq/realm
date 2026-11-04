// render-boundary-3b.test.ts — caching 3-B, Part A (C1, D4.4-2, D4.4-3; MA 1's seam-1 conditions):
// the renderer's placeholder observer, the one derivation of a prompt's stable boundary, and the rule
// for which placeholders are stable. Each cell names (a) the change that turns it red and (b) what it
// prints when it fails: texts built here from fake values, offsets and booleans.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  FILTER_STABILITY,
  UnknownFilterError,
  isStablePlaceholder,
  renderTemplate,
  renderTemplateWithBoundary,
  type PlaceholderEvent,
} from './render-template.js';
import { stepBrief } from './ways.js';
import { writtenSnapshot } from './snapshot.js';
import type { RunRecord, WorkflowContextSnapshot } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const snap = (content: string): WorkflowContextSnapshot => ({
  source_path: '/fake/ctx.md',
  content,
  content_hash: 'fake',
  loaded_at: '2026-01-01T00:00:00.000Z',
});
const ctx = {
  evidenceByStep: { prior: { findings: ['a', 'b'], score: 3.14159 } },
  runParams: { name: 'Ada', items: ['x', 'y'], count: 2, when: '2026-01-02T03:04:05Z' },
  workflowContext: {
    snapshots: { rules: snap('Rule one.\nRule two.'), tone: snap('Be kind.') },
    wrapper: 'xml' as const,
  },
};
/** #715 (b): a fixed render instant for the cells that render `from_now`. */
const AT = { at: new Date('2026-01-01T00:00:00Z') };
/** A template that runs every filter of `applyFilter` once, plus unresolved and context ones. */
const EVERY_FILTER =
  'Start. {{ workflow.context.rules }} {{ workflow.context.tone.raw | upper }} ' +
  '{{ run.params.name | lower }} {{ run.params.name | capitalize }} {{ run.params.name | truncate: 2 }} ' +
  '{{ run.params.items | bullets }} {{ run.params.items | join: + }} {{ run.params.missing | default: none }} ' +
  '{{ run.params.name | upper }} {{ context.resources.prior.findings | pluck: x }} {{ run.params.items | count }} ' +
  '{{ run.params.items | limit: 1 }} {{ run.params.items | compact }} {{ context.resources.prior.score | round: 2 }} ' +
  '{{ context.resources.prior.score | floor }} {{ context.resources.prior.score | ceil }} {{ run.params.count | abs }} ' +
  '{{ run.params.count | number_format }} {{ run.params.count | percent }} {{ run.params.name | replace: A, B }} ' +
  '{{ run.params.count | yesno }} {{ run.params.items | and_join }} {{ run.params.name | trim }} ' +
  '{{ run.params.items | first }} {{ run.params.items | last }} {{ run.params.items | sum }} ' +
  '{{ run.params.items | flatten }} {{ run.params.name | split: d }} {{ run.params.items | sort }} ' +
  '{{ run.params.items | unique }} {{ run.params.name | title }} {{ run.params.name | code }} ' +
  '{{ run.params.name | indent: 2 }} {{ run.params.when | date }} {{ run.params.when | from_now }} ' +
  '{{ run.params.count | duration }} {{ run.params.unknown }} {{ run.params.name | nosuchfilter }} End.';

describe('caching 3-B A1 — the placeholder observer is pure', () => {
  it('(a) the output is byte-identical with and without an observer, over every filter', () => {
    const events: PlaceholderEvent[] = [];
    // #715 (b): a fixed render instant, so `from_now` resolves (with none it is left as written).
    const plain = renderTemplate(EVERY_FILTER, ctx, { time: AT });
    const watched = renderTemplate(EVERY_FILTER, ctx, {
      time: AT,
      onPlaceholder: (e) => {
        events.push(e);
        return 'ignored' as never;
      },
    });
    // (a) red when the observer's return replaces the output, or the loop rebuilds the text
    //     differently; (b) prints the two lengths and whether they are equal.
    expect({ equal: watched === plain, lengths: [plain.length, watched.length] }).toEqual({
      equal: true,
      lengths: [plain.length, plain.length],
    });
    // Every placeholder was seen, and each event's span is its replacement in the output.
    expect(events).toHaveLength([...EVERY_FILTER.matchAll(/\{\{([^{}]+)\}\}/g)].length);
    // `from_now` ran at the fixed instant (its placeholder is not left as written).
    expect(plain.includes('from_now')).toBe(false);
  });

  it('(b) the observer sees the unresolved placeholders onSubstitution never sees', () => {
    const substituted: string[] = [];
    const seen: Array<[string, boolean]> = [];
    renderTemplate(
      '{{ run.params.name }} {{ run.params.unknown }} {{ run.params.name | nope }}',
      ctx,
      {
        onSubstitution: (r, path) => {
          substituted.push(path);
          return r;
        },
        onPlaceholder: (e) => seen.push([e.path, e.resolved]),
      },
    );
    // (a) red when the observer fires only for resolved placeholders; (b) prints both lists.
    expect({ substituted, seen }).toEqual({
      substituted: ['run.params.name'],
      seen: [
        ['run.params.name', true],
        ['run.params.unknown', false],
        ['run.params.name', false],
      ],
    });
  });

  it("(c) the offsets count onSubstitution's RETURNED lengths (a direct renderTemplate call)", () => {
    const spans: Array<[number, number]> = [];
    const out = renderTemplate('ab {{ run.params.name }} cd {{ run.params.unknown }} ef', ctx, {
      onSubstitution: () => 'LONGER-VALUE',
      onPlaceholder: (e) => spans.push([e.start, e.end]),
    });
    // (a) red when the offsets use the raw value's length (`Ada`, 3) instead of the hook's return
    //     (12); (b) prints the output and the spans.
    expect({ out, spans, texts: spans.map(([s, e]) => out.slice(s, e)) }).toEqual({
      out: 'ab LONGER-VALUE cd {{ run.params.unknown }} ef',
      spans: [
        [3, 15],
        [19, 43],
      ],
      texts: ['LONGER-VALUE', '{{ run.params.unknown }}'],
    });
  });

  it('(d) with an observer attached, a strict unknown filter throws the same UnknownFilterError', () => {
    const template = 'x {{ run.params.name | nosuchfilter }} y';
    const thrown = (withObserver: boolean): string => {
      try {
        renderTemplate(template, ctx, {
          strict: true,
          ...(withObserver ? { onPlaceholder: () => undefined } : {}),
        });
        return 'no throw';
      } catch (err) {
        return err instanceof UnknownFilterError ? `UnknownFilterError ${err.filterName}` : 'other';
      }
    };
    // (a) red when the observer swallows the error; (b) prints both outcomes.
    expect([thrown(false), thrown(true)]).toEqual([
      'UnknownFilterError nosuchfilter',
      'UnknownFilterError nosuchfilter',
    ]);
    const lenient = renderTemplate(template, ctx);
    expect(renderTemplate(template, ctx, { onPlaceholder: () => undefined })).toBe(lenient);
  });

  it('(e) M3: a value that is the literal text of a placeholder is classed by the funnel, not the text', () => {
    const seen: boolean[] = [];
    const literal = { ...ctx, runParams: { v: '{{ workflow.context.x }}' } };
    const out = renderTemplate('{{ run.params.v }}', literal, {
      onPlaceholder: (e) => seen.push(e.resolved),
    });
    // (a) red when `resolved` is read by comparing the output with `{{ … }}`; (b) prints both.
    expect({ out, seen }).toEqual({ out: '{{ workflow.context.x }}', seen: [true] });
  });
});

describe('caching 3-B A2 — one derivation, never at the gate mint', () => {
  it('renderTemplateWithBoundary: the text is renderTemplate’s, and chars is the first unstable start', () => {
    const template =
      'Fixed rules: {{ workflow.context.rules }}\nUser: {{ run.params.name }} and more';
    const { text, stable } = renderTemplateWithBoundary(template, ctx);
    // (a) red when the boundary is not the first unstable placeholder's output offset; (b) prints them.
    expect({
      same: text === renderTemplate(template, ctx),
      stable,
      head: text.slice(0, stable.chars),
    }).toEqual({
      same: true,
      stable: { chars: text.indexOf('Ada'), unit: 'utf16' },
      head: 'Fixed rules: <rules>\nRule one.\nRule two.\n</rules>\nUser: ',
    });
    // No unstable placeholder: the whole text.
    expect(
      renderTemplateWithBoundary('All static {{ workflow.context.tone.raw }}.', ctx).stable,
    ).toEqual({
      chars: 'All static Be kind..'.length,
      unit: 'utf16',
    });
  });

  it('#715 (b): the render instant is forwarded, and a `from_now` at it is where the head ends', () => {
    const template = 'Rules: {{ workflow.context.tone.raw }} Due {{ run.params.when | from_now }}.';
    const { text, stable } = renderTemplateWithBoundary(template, ctx, { time: AT });
    // (a) red when the wrapper drops `time` (the `from_now` placeholder is then left as written, and
    //     the text differs from renderTemplate's at the same instant); (b) prints the text and boundary.
    expect({
      text,
      same: text === renderTemplate(template, ctx, { time: AT }),
      head: text.slice(0, stable.chars),
    }).toEqual({
      text: expect.not.stringContaining('from_now'),
      same: true,
      head: 'Rules: Be kind. Due ',
    });
  });

  it('D4.4-2 (b): both gate-mint renders build their options inline, without the observer', () => {
    const source = readFileSync(new URL('./execution-loop.ts', import.meta.url), 'utf8');
    // Each `renderTemplate(` call with `strict: true` is a mint render; its options are the third
    // argument, an object literal written at the call.
    const calls: string[] = [];
    for (
      let i = source.indexOf('renderTemplate(');
      i !== -1;
      i = source.indexOf('renderTemplate(', i + 1)
    ) {
      let depth = 0;
      let j = i + 'renderTemplate'.length;
      for (; j < source.length; j++) {
        if (source[j] === '(') depth++;
        else if (source[j] === ')' && --depth === 0) break;
      }
      const call = source.slice(i, j + 1);
      if (call.includes('strict: true')) calls.push(call);
    }
    // (a) red when a mint render attaches an observer, or the boundary render is used at the mint;
    //     (b) prints the calls' count and which carry the observer.
    expect({
      mintRenders: calls.length,
      withObserver: calls.filter((c) => c.includes('onPlaceholder')).length,
      boundaryRenderInLoop: source.includes('renderTemplateWithBoundary'),
    }).toEqual({ mintRenders: 2, withObserver: 0, boundaryRenderInLoop: false });
  });
});

describe('caching 3-B A3 — which placeholders are stable', () => {
  it("the stability table's keys are exactly applyFilter's case labels (found by name, not by line)", () => {
    const source = readFileSync(new URL('./render-template.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function applyFilter(');
    // The function's body: from its first `{` after the signature to the matching `}`.
    const open = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    const labels = [...source.slice(open, end).matchAll(/^\s*case '([a-z_]+)':/gm)].map(
      (m) => m[1]!,
    );
    // (a) red when a case label is added to applyFilter with no table row (or a row has no label);
    //     (b) prints both key sets.
    expect({ table: Object.keys(FILTER_STABILITY).sort(), labels: [...labels].sort() }).toEqual({
      table: [...labels].sort(),
      labels: [...labels].sort(),
    });
    expect(labels).toHaveLength(34);
    expect(FILTER_STABILITY.from_now).toBe('unstable');
  });

  it('the rule: resolved, workflow.context.*, every filter stable — each conjunct alone unstable', () => {
    const ev = (over: Partial<PlaceholderEvent>): PlaceholderEvent => ({
      path: 'workflow.context.rules',
      filters: [],
      resolved: true,
      start: 0,
      end: 1,
      ...over,
    });
    // (a) red when one conjunct is dropped; (b) prints each verdict.
    expect({
      stable: isStablePlaceholder(ev({})),
      stableFilters: isStablePlaceholder(ev({ filters: ['upper', 'trim'] })),
      unresolved: isStablePlaceholder(ev({ resolved: false })),
      runParam: isStablePlaceholder(ev({ path: 'run.params.name' })),
      evidence: isStablePlaceholder(ev({ path: 'context.resources.prior.findings' })),
      fromNow: isStablePlaceholder(ev({ filters: ['upper', 'from_now'] })),
      unknownFilter: isStablePlaceholder(ev({ filters: ['nosuchfilter'] })),
      inheritedName: isStablePlaceholder(ev({ filters: ['toString'] })),
    }).toEqual({
      stable: true,
      stableFilters: true,
      unresolved: false,
      runParam: false,
      evidence: false,
      fromNow: false,
      unknownFilter: false,
      inheritedName: false,
    });
  });

  it('`default` rescuing an absent context path is stable; the same path unresolved is not', () => {
    const rescued = renderTemplateWithBoundary(
      'A {{ workflow.context.absent | default: none }} B {{ run.params.name }}',
      ctx,
    );
    const unresolved = renderTemplateWithBoundary('A {{ workflow.context.absent }} B', ctx);
    // (a) red when `default` over an absent context path is classed unstable, or an unresolved
    //     context path stable; (b) prints both boundaries.
    expect({ rescued: rescued.stable.chars, unresolved: unresolved.stable.chars }).toEqual({
      rescued: 'A none B '.length,
      unresolved: 2,
    });
  });

  it('stepBrief carries stable_prefix whenever it carries a prompt, and none without one', () => {
    const def = {
      id: 'wf',
      name: 'wf',
      version: 1,
      steps: {
        ask: {
          description: 'Ask.',
          execution: 'agent',
          prompt: 'Rules:\n{{ workflow.context.rules }}\nName: {{ run.params.name }}',
        },
        plain: { description: 'Plain.', execution: 'auto' },
      },
    } as unknown as WorkflowDefinition;
    const run = {
      id: 'r1',
      params: { name: 'Ada' },
      evidence: [],
      completed_steps: [],
      failed_steps: [],
      workflow_context_snapshots: { rules: snap('Be brief.') },
    } as unknown as RunRecord;
    // #715 (b): the brief is rendered at a snapshot's reading; this prompt has no `from_now`.
    const snapshot = writtenSnapshot(run, new Date('2026-01-01T00:00:00Z'));
    const brief = stepBrief(def, snapshot, 'ask');
    // (a) red when stepBrief drops the boundary or computes it from another render; (b) prints them.
    expect({ prompt: brief.prompt, stable: brief.stable_prefix }).toEqual({
      prompt: 'Rules:\n<rules>\nBe brief.\n</rules>\nName: Ada',
      stable: { chars: 'Rules:\n<rules>\nBe brief.\n</rules>\nName: '.length, unit: 'utf16' },
    });
    expect('stable_prefix' in stepBrief(def, snapshot, 'plain')).toBe(false);
  });
});
