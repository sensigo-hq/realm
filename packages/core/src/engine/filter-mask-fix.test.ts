// filter-mask-fix.test.ts — the filter-mask fix, PR 1 (core). A value Realm hides, shown in a template
// through a filter, used to reach a gate's question and a step's prompt in its filtered form: the
// filters ran BEFORE the mask, and the mask knows only a value's exact forms. Now the renderer masks
// each resolved value before its filters (B1), at the tier the render site names (B2), and the
// disclosure walk strips span marks before it matches (B3). Every fake here is made up for the test.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { compileDisclosure, type DisclosureSet } from '../utils/redaction.js';
import { discloseLeaf, discloseValue } from '../utils/disclosure-walk.js';
import { executeStep, pendingGateQuestion } from './execution-loop.js';
import { writtenSnapshot } from './snapshot.js';
import { endsWithCutSentence, mintQuestionView, mintSubstitutions } from './question-view.js';
import { renderTemplate, UnknownFilterError } from './render-template.js';

const SECRET = 'fm-fake-declared-6a1c';
const ENV_VALUE = 'fm-fake-environment-2b7d';
const NUMBER_SECRET = '424242424';
const MARK = String.fromCharCode(0xe000);
/** The declared fake with a span mark planted after its fifth character. */
const MARKED = `${SECRET.slice(0, 5)}${MARK}${SECRET.slice(5)}`;

/** A set holding the declared fakes and one environment fake, for `audience`. */
function setFor(audience: 'private' | 'agent'): DisclosureSet {
  return compileDisclosure(
    [
      { value: SECRET, source: 'declared:FM_KEY' },
      { value: NUMBER_SECRET, source: 'declared:FM_PIN' },
      { value: ENV_VALUE, source: 'env:FM_ENV' },
    ],
    { declared: 'resolved', audience, environment: 'swept' },
  ).set;
}

const CTX = {
  evidenceByStep: {
    fetch: {
      note: SECRET,
      list: [SECRET, SECRET],
      mixed: `Key is ${SECRET}`,
      pins: [Number(NUMBER_SECRET), 1],
      plain: 'a plain line',
      env: ENV_VALUE,
      rows: [{ password: 'pw-not-declared-1' }, { password: 'pw-not-declared-2' }],
      collide: { [SECRET]: 1, [NUMBER_SECRET]: 2 },
      count: { n: Number(NUMBER_SECRET) },
      markedPlain: `plain${MARK}text`,
    },
  },
  runParams: {},
};

const at = (tier: 'declared' | 'all', audience: 'private' | 'agent' = 'private') => ({
  disclosure: { set: setFor(audience), tier },
});

describe('the filter-mask fix (B1) — the renderer masks each resolved value before its filters', () => {
  it('(6) a value wholly a hidden member stays the marker through upper, lower, capitalize and truncate', () => {
    const shown = Object.fromEntries(
      ['upper', 'lower', 'capitalize', 'truncate: 5', 'round'].map((f) => [
        f,
        renderTemplate(`{{ context.resources.fetch.note | ${f} }}`, CTX, at('declared')),
      ]),
    );
    // (1) red when the filters run before the mask (the filtered form leaks: `FM-FAKE-…`), or the
    //     whole-marker stop is removed (`[redacted]`, `[RE…`, and `round` leaves the expression as
    //     written); (2) prints each filter's output.
    expect(shown).toEqual({
      upper: '[REDACTED]',
      lower: '[REDACTED]',
      capitalize: '[REDACTED]',
      'truncate: 5': '[REDACTED]',
      // The page's sentence (input-map-and-templates.md): a filter that does not work on the kind of
      // value leaves the expression as written, but a value hidden whole shows as the marker.
      round: '[REDACTED]',
    });
  });

  it('(6) `| count` on an array of two members gives 2; `| first | truncate: 3` gives the marker', () => {
    // (1) red when the walk returns a string for an array (`count` then fails: the placeholder text),
    //     or the stop runs only before the first filter (`[RE…`); (2) prints both outputs.
    expect({
      count: renderTemplate('{{ context.resources.fetch.list | count }}', CTX, at('declared')),
      firstCut: renderTemplate(
        '{{ context.resources.fetch.list | first | truncate: 3 }}',
        CTX,
        at('declared'),
      ),
    }).toEqual({ count: '2', firstCut: '[REDACTED]' });
  });

  it('(6) a value holding a member and other text runs its chain: no member survives, the marker is re-cased (the mixed case)', () => {
    const out = renderTemplate('{{ context.resources.fetch.mixed | lower }}', CTX, at('declared'));
    // (1) red when the mixed value is masked after its filter (the member leaks lower-cased), or the
    //     chain is stopped for a value that is not wholly a marker; (2) prints the output.
    expect(out).toBe('key is [redacted]');
  });

  it('a filter that fails on a masked value leaves the placeholder text (fail closed)', () => {
    // (1) red when `sum` sums a masked number as a number, or a mismatch shows the value; (2) prints it.
    expect(renderTemplate('{{ context.resources.fetch.pins | sum }}', CTX, at('declared'))).toBe(
      '{{ context.resources.fetch.pins | sum }}',
    );
  });

  it('(5) a `workflow.context.*` value through a filter is masked before the filter', () => {
    const ctx = {
      ...CTX,
      workflowContext: {
        snapshots: {
          notes: { source_path: '/x', content: SECRET, content_hash: 'h', loaded_at: 'now' },
        },
        wrapper: 'none' as const,
      },
    };
    // (1) red when the context path's value is not masked before its filter (the upper-cased fake);
    //     (2) prints both outputs.
    expect({
      upper: renderTemplate('{{ workflow.context.notes | upper }}', ctx, at('all', 'agent')),
      raw: renderTemplate('{{ workflow.context.notes.raw | upper }}', ctx, at('all', 'agent')),
    }).toEqual({ upper: '[REDACTED]', raw: '[REDACTED]' });
  });

  it('(7) the tier: at `declared` an environment value is shown (and re-cased); at `all` it is masked', () => {
    const template = '{{ context.resources.fetch.env | upper }}';
    // (1) red when the renderer ignores the tier it is given (both masked, or both shown); (2)
    //     prints both outputs.
    expect({
      declared: renderTemplate(template, CTX, at('declared', 'agent')),
      all: renderTemplate(template, CTX, at('all', 'agent')),
    }).toEqual({ declared: ENV_VALUE.toUpperCase(), all: '[REDACTED]' });
  });

  it('(B6) an object value is the walk’s: a number holding a member is the quoted marker, colliding keys get #2, at `all` a credential name’s value is hidden whole', () => {
    // (1) red when the renderer masks only string leaves (the number and keys pass), or does not run
    //     the walk's credential-name rule at `all`; (2) prints the three outputs.
    expect({
      number: renderTemplate('{{ context.resources.fetch.count }}', CTX, at('declared')),
      keys: renderTemplate('{{ context.resources.fetch.collide }}', CTX, at('declared')),
      pluck: renderTemplate(
        '{{ context.resources.fetch.rows | pluck: password | join: ", " }}',
        CTX,
        at('all', 'agent'),
      ),
    }).toEqual({
      number: '{\n  "n": "[REDACTED]"\n}',
      // An integer-like key comes first in a JavaScript object: the PIN's key, then the other.
      keys: '{\n  "[REDACTED]": 2,\n  "[REDACTED]#2": 1\n}',
      pluck: '[REDACTED], [REDACTED]',
    });
  });

  it('the hooks keep their contracts: `onSubstitution` sees the final string, `onPlaceholder` its offsets', () => {
    const seen: string[] = [];
    const spans: Array<[number, number]> = [];
    const out = renderTemplate('A {{ context.resources.fetch.note | upper }} B', CTX, {
      ...at('declared'),
      onSubstitution: (rendered) => {
        seen.push(rendered);
        return rendered;
      },
      onPlaceholder: (e) => spans.push([e.start, e.end]),
    });
    // (1) red when the hook is handed the raw value or the observer's offsets miss the masked
    //     replacement; (2) prints the output, what the hook saw and the offsets.
    expect({ out, seen, spans }).toEqual({
      out: 'A [REDACTED] B',
      seen: ['[REDACTED]'],
      spans: [[2, 12]],
    });
  });
});

describe('the filter-mask fix (B1) — every filter name is checked before any filter runs', () => {
  it('an unknown name after a filter the hidden value stops at is reported (strict) or leaves the placeholder (lenient), as for a plain value', () => {
    const outcome = (template: string, strict: boolean): string => {
      try {
        return renderTemplate(template, CTX, { ...at('declared'), strict });
      } catch (err) {
        return err instanceof UnknownFilterError ? `unknown ${err.filterName}` : String(err);
      }
    };
    // (1) red when the names are checked only as the chain runs (the hidden value's stop at `upper`
    //     hides `nosuch`); (2) prints the four outcomes.
    expect({
      hiddenStrict: outcome('{{ context.resources.fetch.note | upper | nosuch }}', true),
      plainStrict: outcome('{{ context.resources.fetch.plain | upper | nosuch }}', true),
      hiddenLenient: outcome('{{ context.resources.fetch.note | upper | nosuch }}', false),
      plainLenient: outcome('{{ context.resources.fetch.plain | upper | nosuch }}', false),
    }).toEqual({
      hiddenStrict: 'unknown nosuch',
      plainStrict: 'unknown nosuch',
      hiddenLenient: '{{ context.resources.fetch.note | upper | nosuch }}',
      plainLenient: '{{ context.resources.fetch.plain | upper | nosuch }}',
    });
  });

  it('with no set too: `| count | nosuch` on a string reports the unknown name (the mismatch used to hide it)', () => {
    let caught: unknown;
    try {
      renderTemplate('{{ context.resources.fetch.plain | count | nosuch }}', CTX, { strict: true });
    } catch (err) {
      caught = err;
    }
    // (1) red when the chain runs before the names are checked (`count`'s mismatch returns the
    //     placeholder first); (2) prints what was thrown.
    expect(caught instanceof UnknownFilterError ? caught.filterName : caught).toBe('nosuch');
  });
});

describe('the filter-mask fix (B4) — a render with no set behaves as before', () => {
  it('(11) the same template with no disclosure renders every value raw, filtered as before', () => {
    const out = renderTemplate(
      [
        'u={{ context.resources.fetch.note | upper }}',
        't={{ context.resources.fetch.note | truncate: 5 }}',
        'c={{ context.resources.fetch.list | count }}',
        'p={{ context.resources.fetch.plain }}',
        'm={{ context.resources.fetch.mixed | lower }}',
        'k={{ context.resources.fetch.markedPlain }}',
      ].join(' '),
      CTX,
    );
    // (1) red when the mask (or the whole-marker stop) runs with no set — the walk would also strip
    //     the mark a render with no set keeps as it is; (2) prints the output, the mark as <U+E000>.
    expect(out.replace(MARK, '<U+E000>')).toBe(
      `u=${SECRET.toUpperCase()} t=fm-fa… c=2 p=a plain line m=key is ${SECRET.toLowerCase()} k=plain<U+E000>text`,
    );
  });
});

describe('the filter-mask fix (B2) — the question fallback (`realm run inspect`, a gate opened before its message was stored)', () => {
  it('with the host’s set the step’s prompt renders each value masked before its filters; with none, as before', async () => {
    const definition: WorkflowDefinition = {
      id: 'fm-fallback',
      name: 'Fallback',
      version: 1,
      steps: {
        g: {
          description: 'The gate.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          prompt: 'Approve {{ run.params.k | upper }}?',
          gate: { choices: ['approve'] },
        },
      },
    };
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: { k: SECRET },
    });
    const snap = writtenSnapshot(
      {
        ...record,
        pending_gate: {
          gate_id: 'g1',
          step_name: 'g',
          preview: {},
          choices: ['approve'],
          opened_at: '',
        },
      },
      new Date(),
    );
    // (1) red when the fallback renders without the set it is given (the upper-cased fake), or masks
    //     with none; (2) prints both questions.
    expect({
      withSet: pendingGateQuestion(definition, snap, { disclosure: setFor('private') }),
      withNone: pendingGateQuestion(definition, snap),
    }).toEqual({ withSet: 'Approve [REDACTED]?', withNone: `Approve ${SECRET.toUpperCase()}?` });
  });
});

describe('the filter-mask fix (B3) — the walk strips span marks before it matches', () => {
  it('(8) a value and a key holding a planted mark are masked; the door’s leaf transform too', () => {
    const set = setFor('agent');
    const walked = discloseValue({ v: MARKED, [MARKED]: 'k' }, set, 'agent').value;
    // (1) red when the walk matches before it strips (the marked value passes as itself); (2)
    //     prints the walked value (the mark shown as U+E000) and the leaf.
    expect({
      walked: JSON.stringify(walked).replace(MARK, '<U+E000>'),
      leaf: discloseLeaf(MARKED, set, 'all').replace(MARK, '<U+E000>'),
    }).toEqual({
      walked: JSON.stringify({ v: '[REDACTED]', '[REDACTED]': 'k' }),
      leaf: '[REDACTED]',
    });
  });
});

describe('the filter-mask fix (B2) — the gate question masks at the source, the over-budget rerender included', () => {
  /** One `auto` gate step whose message shows the dispatcher's output. */
  const def = (message: string): WorkflowDefinition => ({
    id: 'fm-gate',
    name: 'Filter-mask gate',
    version: 1,
    steps: {
      g: {
        description: 'The gate.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], message },
      },
    },
  });
  const opened = async (
    message: string,
    output: Record<string, unknown>,
    set: DisclosureSet | undefined,
  ): Promise<string | undefined> => {
    const store = new InMemoryStore();
    const d = def(message);
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(store, d, {
      runId: run.id,
      command: 'g',
      input: {},
      dispatcher: async () => output,
      ...(set !== undefined ? { disclosure: set } : {}),
    });
    return (await store.get(run.id)).record.pending_gate?.resolved_message;
  };

  it('(1) a gate message showing a declared value through `| upper` stores the marker, beside the plain field', async () => {
    const stored = await opened(
      'Upper: {{ context.resources.g.note | upper }}\nPlain: {{ context.resources.g.note }}',
      { note: SECRET },
      setFor('agent'),
    );
    // (1) red when the gate site renders without the set (the upper-cased fake is stored); (2)
    //     prints the stored question.
    expect(stored).toBe('Upper: [REDACTED]\nPlain: [REDACTED]');
  });

  it('(7) the question masks at the declared tier, whatever door opened it: an environment value under `| upper` is shown', async () => {
    const stored = await opened(
      'Env: {{ context.resources.g.env | upper }}',
      { env: ENV_VALUE },
      setFor('agent'),
    );
    // (1) red when the gate site masks at the set's tier (`all` for the agent's set: a marker); (2)
    //     prints the stored question.
    expect(stored).toBe(`Env: ${ENV_VALUE.toUpperCase()}`);
  });

  it('(4) over the budget: the rerender masks before its filters — only the plain field is cut, the marker whole, the cut sentence last', async () => {
    const LONG = `fm-long-declared-${'k'.repeat(103)}`; // 120 characters
    expect(LONG.length).toBe(120);
    // The rerender runs only when the question is over the budget AND each value keeps room beside
    // its marker once the cut sentence has its place (about 170 characters): 200 characters of fixed
    // text and a 450-character plain field reach it; 450 of fixed text leave a cap of 0 (the whole
    // question is cut instead, and the rerender never runs).
    const PLAIN = 'p'.repeat(450);
    const FIXED = 'F'.repeat(200);
    const set = compileDisclosure([{ value: LONG, source: 'declared:FM_LONG' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const message = `${FIXED} {{ context.resources.g.long | upper }} {{ context.resources.g.long }} {{ context.resources.g.plain }}`;
    // The site's own composition, to read the lengths its hook records (what the caps come from).
    const ctx = { evidenceByStep: { g: { long: LONG, plain: PLAIN } }, runParams: {} };
    const subs = mintSubstitutions(message, set);
    const raw = renderTemplate(message, ctx, {
      strict: true,
      time: 'stored',
      onSubstitution: subs.onSubstitution!,
      disclosure: { set, tier: 'declared' },
    });
    const view = mintQuestionView({
      message: raw,
      substitutions: subs,
      rerender: (onSubstitution) =>
        renderTemplate(message, ctx, {
          strict: true,
          onSubstitution,
          time: 'stored',
          disclosure: { set, tier: 'declared' },
        }),
      preview: {},
      choices: ['approve'],
      set,
      ids: { run_id: 'r', gate_id: 'g1', step: 'g' },
    }).resolved_message!;
    // And the engine's own site, end to end.
    const stored = (await opened(message, { long: LONG, plain: PLAIN }, set))!;
    const fragment = LONG.toUpperCase().slice(0, 12);
    // (1) red when either render (the first or the rerender) runs its filters before the mask: the
    //     hook records 120, and the stored question holds a cut piece of the upper-cased fake; (2)
    //     prints the lengths and the facts of both questions.
    expect({
      lengths: subs.lengths,
      composed: {
        markers: view.split('[REDACTED]').length - 1,
        fragment: view.includes(fragment),
        plainWhole: view.includes(PLAIN),
        cutSentence: endsWithCutSentence(view),
      },
      engine: {
        markers: stored.split('[REDACTED]').length - 1,
        fragment: stored.includes(fragment),
        plainWhole: stored.includes(PLAIN),
        cutSentence: endsWithCutSentence(stored),
      },
    }).toEqual({
      lengths: [10, 10, 450],
      composed: { markers: 2, fragment: false, plainWhole: false, cutSentence: true },
      engine: { markers: 2, fragment: false, plainWhole: false, cutSentence: true },
    });
  });
});
