// check-quotes.test.ts — the built-in `check_quotes` handler (issue #760; design D1, D4, D5). It
// replaces `validate-verbatim-quotes.test.ts` by name: the old handler was never registered and its
// contract (candidates in `inputs.params`, `accepted`/`rejected`) is gone. What a failing cell
// prints: states, counts, booleans, codes and the warning's own words — never a span of the source.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckQuotesHandler, CHECK_QUOTES_CONFIG_KEYS } from './check-quotes.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { unmetCapabilities } from '../engine/capability.js';
import { advanceRun, executeChain } from '../engine/execution-loop.js';
import { applyResume } from '../engine/apply-resume.js';
import { offeredResumeWay } from '../engine/pending.js';
import { quoteCacheHolds } from './primitives/locate-quote.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { StepContext } from '../extensions/step-handler.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const SOURCE =
  'The Tenant shall pay the rent quarterly in advance. The Landlord shall repair the roof and ' +
  'the structure of the building at its own cost. Either party may end this agreement early.';

const handler = new CheckQuotesHandler();

/** A context whose evidence holds the document under `doc.text` and the values under
 *  `extract.candidates` (the defaults), with `config` added. */
function ctx(
  candidates: unknown,
  config: Record<string, unknown> = {},
  resources?: Record<string, unknown>,
): StepContext {
  return {
    run_id: 'r',
    run_params: {},
    config: { source_step: 'doc', candidates_step: 'extract', ...config },
    resources: resources ?? { doc: { text: SOURCE }, extract: { candidates } },
  };
}

interface Data {
  results: Array<Record<string, unknown> & { quote_check: { state: string; parts: unknown[] } }>;
  by_state: Record<string, number>;
  all_found: boolean;
  candidates_found: number;
}

async function run(context: StepContext): Promise<{ data: Data; warn: string | undefined }> {
  const result = await handler.execute({ params: {} }, context);
  return { data: result.data as unknown as Data, warn: result.warn?.message };
}

async function refusal(context: StepContext): Promise<WorkflowError | undefined> {
  try {
    await handler.execute({ params: {} }, context);
    return undefined;
  } catch (err) {
    return err as WorkflowError;
  }
}

const FOUND = {
  field: 'rent',
  value: 'quarterly',
  quote: 'The Tenant shall pay the rent quarterly',
};
const INVENTED = (field: string) => ({
  field,
  value: 'x',
  quote: 'The Landlord shall repaint every window each spring',
});

describe('check_quotes — registered on every door', () => {
  it('the default registry holds it, and the capability preflight lists nothing for it', () => {
    const def = {
      id: 'w',
      name: 'W',
      version: 1,
      steps: { quote_check: { description: 'C', execution: 'auto', handler: 'check_quotes' } },
    } as unknown as WorkflowDefinition;
    const registry = createDefaultRegistry();
    // (a) red when it is not registered (the engine refuses `Handler 'check_quotes' is not
    //     registered`, and the preflight names one requirement); (b) prints a boolean and a count.
    expect({
      registered: registry.getHandler('check_quotes') instanceof CheckQuotesHandler,
      unmet: unmetCapabilities(def, registry).length,
    }).toEqual({ registered: true, unmet: 0 });
  });
});

describe('check_quotes — the record, always', () => {
  it('every quote found: `data` with each value and its quote_check, no warning', async () => {
    const { data, warn } = await run(ctx([FOUND]));
    // (a) red when `data` is dropped on the all-found path or a warning is raised; (b) prints the
    //     state, the flags and whether a warning exists.
    expect({
      state: data.results[0]!.quote_check.state,
      field: data.results[0]!['field'],
      all_found: data.all_found,
      candidates_found: data.candidates_found,
      warned: warn !== undefined,
    }).toEqual({
      state: 'exact',
      field: 'rent',
      all_found: true,
      candidates_found: 1,
      warned: false,
    });
  });

  it('an empty list of values: nothing checked, all_found true, no warning', async () => {
    const { data, warn } = await run(ctx([]));
    // (a) red when an empty list is refused, counted, or warned about; (b) prints the counts, the
    //     flag and whether a warning exists.
    expect({
      results: data.results.length,
      candidates_found: data.candidates_found,
      all_found: data.all_found,
      warned: warn !== undefined,
    }).toEqual({ results: 0, candidates_found: 0, all_found: true, warned: false });
  });

  it('by_state counts every state, and sums to candidates_found', async () => {
    const { data } = await run(
      ctx([
        FOUND,
        INVENTED('a'),
        { field: 'b', quote: '', value: null },
        { field: 'c', value: '' },
      ]),
    );
    const sum = Object.values(data.by_state).reduce((a, b) => a + b, 0);
    // (a) red when a state is counted twice or not at all; (b) prints the counts and the sum.
    expect({ by_state: data.by_state, sum, total: data.candidates_found }).toEqual({
      by_state: {
        exact: 1,
        reformatted: 0,
        stitched: 0,
        stitched_out_of_order: 0,
        not_found: 1,
        unquoted: 2,
      },
      sum: 4,
      total: 4,
    });
  });

  it('unquoted: no quote and no value is not a failure; no quote WITH a value is not_found', async () => {
    const { data } = await run(
      ctx([
        { field: 'guarantor', quote: '', value: null },
        { field: 'deposit', quote: '', value: '24000' },
      ]),
    );
    // (a) red when an empty value is counted as not_found, or a value without a quote as unquoted;
    //     (b) prints the two states, their part counts and all_found.
    expect({
      states: data.results.map((r) => [r.quote_check.state, r.quote_check.parts.length]),
      all_found: data.all_found,
    }).toEqual({
      states: [
        ['unquoted', 0],
        ['not_found', 0],
      ],
      all_found: false,
    });
  });

  it('inputs come from the run’s evidence only: candidates in `params` are ignored', async () => {
    const result = await handler.execute(
      { params: { candidates: [INVENTED('decoy')] } },
      ctx([FOUND]),
    );
    const data = result.data as unknown as Data;
    // (a) red when the handler reads `inputs.params`; (b) prints the fields it checked.
    expect(data.results.map((r) => r['field'])).toEqual(['rent']);
  });

  it('defaults: quote_field `quote`, source_field `text`, candidates_field `candidates`; each can be overridden', async () => {
    const byDefault = await run(ctx([FOUND]));
    const overridden = await run(
      ctx(
        undefined,
        { source_field: 'body', candidates_field: 'fields', quote_field: 'verbatim_quote' },
        {
          doc: { body: SOURCE },
          extract: { fields: [{ field: 'rent', verbatim_quote: 'shall pay the rent quarterly' }] },
        },
      ),
    );
    // (a) red when a default is another name (the old `verbatim_quote`) or an override is ignored;
    //     (b) prints the two states.
    expect([
      byDefault.data.results[0]!.quote_check.state,
      overridden.data.results[0]!.quote_check.state,
    ]).toEqual(['exact', 'exact']);
  });

  it('min_part_chars reaches the ladder', async () => {
    // Correction 2 re-pin: the second piece starts a sentence, so the skip rule allows it, and only
    // the floor decides ("either party may" is 16 characters); "at its own cost" resumed mid-sentence.
    const quote = 'The Tenant shall pay … Either party may';
    const atDefault = await run(ctx([{ field: 'f', value: 'v', quote }]));
    const lowered = await run(ctx([{ field: 'f', value: 'v', quote }], { min_part_chars: 15 }));
    // (a) red when the option is not passed on (both stay not_found); (b) prints the two states.
    expect([
      atDefault.data.results[0]!.quote_check.state,
      lowered.data.results[0]!.quote_check.state,
    ]).toEqual(['not_found', 'stitched']);
  });
});

describe('check_quotes — the warning, only when a quote is not found', () => {
  it('names each missing value: its field, the quote’s first 80 characters and the nearest offsets — never the source', async () => {
    // The source spells the shared words its own way, so its span at `nearest` differs from the
    // agent's words: the warning may carry the agent's quote, never the source's text.
    const source =
      'the LANDLORD, shall repair the roof and the structure of the building at its own cost.';
    const long =
      'The Landlord shall repaint every window each spring and every door each autumn, and more words follow here';
    const { data, warn } = await run(
      ctx(
        [],
        {},
        {
          doc: { text: source },
          extract: { candidates: [{ field: 'repairs', value: 'v', quote: long }] },
        },
      ),
    );
    const near = (
      data.results[0]!.quote_check as unknown as { nearest: { start: number; end: number } }
    ).nearest;
    const sourceSpan = source.slice(near.start, near.end);
    // (a) red when the warning drops a part, prints more than 80 characters of the quote, or
    //     carries the source's text at `nearest`; (b) prints the warning's parts as booleans.
    expect({
      // Correction 1 (H4): "values", and a head cut at 80 characters ends with `…`.
      opens: warn?.startsWith("Quote check: 1 of 1 values not found in 'doc.text': repairs — \""),
      head: warn?.includes(`"${long.slice(0, 80)}…"`) === true && !warn.includes(long.slice(0, 81)),
      offsets: warn?.includes(`(nearest match at ${near.start}–${near.end})`),
      sourceSpanDiffers: sourceSpan !== '' && !long.includes(sourceSpan),
      sourceText: warn?.includes(sourceSpan),
      ends: warn?.endsWith(').'),
    }).toEqual({
      opens: true,
      head: true,
      offsets: true,
      sourceSpanDiffers: true,
      sourceText: false,
      ends: true,
    });
  });

  it('a quote with nothing nearby says so; one sharing only a single letter has no `nearest` (correction 1, A7)', async () => {
    const { warn } = await run(ctx([{ field: 'x', value: 'v', quote: '1234 5678' }]));
    const { data } = await run(ctx([{ field: 'y', value: 'v', quote: 'zzzz qqqq' }]));
    const near = (
      data.results[0]!.quote_check as unknown as { nearest?: { start: number; end: number } }
    ).nearest;
    // (a) red when an absent `nearest` prints offsets, or a one-letter span (no whole word) is kept
    //     as `nearest`; (b) prints the warning's tail and the nearest span's length.
    expect({
      none: warn?.endsWith('x — "1234 5678" (no nearby match).'),
      oneLetter: near === undefined ? undefined : near.end - near.start,
    }).toEqual({ none: true, oneLetter: undefined });
  });

  it('13 not found: ten named, then "and 3 more" from the true count', async () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => INVENTED(`f${i + 1}`));
    const { warn } = await run(ctx(thirteen));
    const named = (warn ?? '').match(/f\d+ — /g)?.length;
    // (a) red when the list is not capped, or the remainder is recounted wrongly; (b) prints the
    //     count named and the warning's opening and ending.
    expect({
      opens: warn?.startsWith("Quote check: 13 of 13 values not found in 'doc.text': f1 — "),
      named,
      ends: warn?.endsWith('; and 3 more.'),
    }).toEqual({ opens: true, named: 10, ends: true });
  });
});

describe('check_quotes — every fault is a four-clause refusal', () => {
  // Correction 1 (H6): the STEP failed; resume is offered only for a run that ended failed.
  const CONSEQUENCE = 'so the quote check did not run and this step failed.';
  const READMISSION =
    'then register the workflow again and start a new run; if this run ended failed, realm run resume <run-id> --from <step> runs the step again instead.';
  const FAULTS: Array<[string, StepContext, string]> = [
    [
      'an unknown config key',
      ctx([FOUND], { quote_feild: 'quote' }),
      "the config key 'quote_feild' is not one this handler reads",
    ],
    [
      'a missing source_step',
      { ...ctx([FOUND]), config: { candidates_step: 'extract' } },
      "the config key 'source_step' is required",
    ],
    [
      'a missing candidates_step',
      { ...ctx([FOUND]), config: { source_step: 'doc' } },
      "the config key 'candidates_step' is required",
    ],
    [
      'a non-string key',
      ctx([FOUND], { quote_field: 3 }),
      "the config key 'quote_field' must be a non-empty string (got a number)",
    ],
    [
      'min_part_chars below 4',
      ctx([FOUND], { min_part_chars: 3 }),
      'min_part_chars must be a whole number of at least 4 (got a number 3)',
    ],
    [
      'min_part_chars not whole',
      ctx([FOUND], { min_part_chars: 4.5 }),
      'min_part_chars must be a whole number of at least 4 (got a number 4.5)',
    ],
    [
      'min_part_chars a string',
      ctx([FOUND], { min_part_chars: '20' }),
      'min_part_chars must be a whole number of at least 4 (got a string)',
    ],
    [
      'source_step absent from the run',
      ctx([FOUND], { source_step: 'fetch' }),
      "the source step 'fetch' has no output in this run",
    ],
    [
      'a non-string source field',
      ctx([FOUND], {}, { doc: { text: 7 }, extract: { candidates: [FOUND] } }),
      "'doc.text' is not the document's text (got a number)",
    ],
    [
      'candidates_step absent from the run',
      ctx([FOUND], { candidates_step: 'pull' }),
      "the candidates step 'pull' has no output in this run",
    ],
    [
      'a non-list candidates field',
      ctx({ field: 'rent' }),
      "'extract.candidates' is not a list of candidates (got an object)",
    ],
    [
      'a candidate that is not an object',
      ctx([FOUND, 'rent']),
      "candidate 2 of 'extract.candidates' is not an object (got a string)",
    ],
  ];
  for (const [name, context, validity] of FAULTS) {
    it(name, async () => {
      const err = await refusal(context);
      // (a) red when the fault is not refused, is a bare throw, or drops a clause; (b) prints the
      //     error class, its code and one boolean per clause.
      expect({
        typed: err instanceof WorkflowError,
        code: err?.code,
        validity: err?.message.startsWith(`check_quotes: ${validity}, `),
        consequence: err?.message.includes(CONSEQUENCE),
        readmission: err?.message.endsWith(READMISSION),
      }).toEqual({
        typed: true,
        code: 'ENGINE_HANDLER_FAILED',
        validity: true,
        consequence: true,
        readmission: true,
      });
    });
  }

  it('the config keys are one list', () => {
    // (a) red when a key is renamed, added or dropped; (b) prints the list.
    expect(CHECK_QUOTES_CONFIG_KEYS).toEqual([
      'source_step',
      'source_field',
      'candidates_step',
      'candidates_field',
      'quote_field',
      'min_part_chars',
    ]);
  });
});

describe('check_quotes on the engine — the step records, the author’s guard stops', () => {
  const definition = (guardDependsOn: boolean, config: Record<string, unknown> = {}) =>
    ({
      id: 'quote-guard',
      name: 'Q',
      version: 1,
      steps: {
        extract: { description: 'E', execution: 'agent', depends_on: [] },
        quote_check: {
          description: 'C',
          execution: 'auto',
          handler: 'check_quotes',
          depends_on: ['extract'],
          config: { source_step: 'extract', candidates_step: 'extract', ...config },
        },
        stop_if_missing: {
          description: 'G',
          execution: 'guard',
          ...(guardDependsOn ? { depends_on: ['quote_check'] } : {}),
          abort_unless: ['quote_check.all_found'],
          abort_message: 'A quote is not in the document.',
        },
      },
    }) as unknown as WorkflowDefinition;

  async function drive(def: WorkflowDefinition) {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-760-')));
    const { run: created } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await executeChain(store, def, {
      runId: created.id,
      command: 'extract',
      registry: createDefaultRegistry(),
      input: { text: SOURCE, candidates: [FOUND, INVENTED('repairs')] },
      dispatcher: async (_name, input) => ({ ...input }),
    });
    return { reply, run: await store.get(created.id) };
  }

  it('with depends_on: the check warns, the guard aborts the run, and the check’s record is kept', async () => {
    const { reply, run } = await drive(definition(true));
    const check = run.evidence.find((e) => e.step_id === 'quote_check');
    const output = check?.output_summary as unknown as Data | undefined;
    // (a) red when the guard cannot read `all_found`, or the record is lost on the stop; (b)
    //     prints the phase, the seal, the record's shape and the reply's line.
    expect({
      phase: run.run_phase,
      sealedBy: run.sealed_by?.arm,
      results: output?.results.length,
      all_found: output?.all_found,
      warned: check?.warn?.startsWith('Quote check: 1 of 2 values not found'),
      // Correction 1 (H7, guardrail 7(b)): the later carrier, the reply's `warnings`, keeps it.
      inReply: reply.warnings.some((w) => w.startsWith('Quote check: 1 of 2 values not found')),
      line: reply.context_hint,
    }).toEqual({
      phase: 'aborted',
      sealedBy: 'guard_abort',
      results: 2,
      all_found: false,
      warned: true,
      inReply: true,
      line: "Guard step 'stop_if_missing' aborted the run.",
    });
  });

  it('without depends_on the guard runs first and the run FAILS — why the docs require it', async () => {
    const { run } = await drive(definition(false));
    // (a) red if a guard without the dependency could still stop the run as `aborted`; (b) prints
    //     the phase and the seal.
    expect({ phase: run.run_phase, sealedBy: run.sealed_by?.arm }).toEqual({
      phase: 'failed',
      sealedBy: 'guard_resolution_error',
    });
  });

  it('a fault reaches the reply as ENGINE_HANDLER_FAILED, with no `threw:` prefix', async () => {
    const { reply, run } = await drive(definition(true, { quote_feild: 'quote' }));
    // (a) red when the handler throws a bare Error (the engine then prefixes `Handler … threw:`);
    //     (b) prints the code, the phase and two booleans.
    expect({
      code: reply.error_code,
      phase: run.run_phase,
      named: run.terminal_reason?.startsWith("Step 'quote_check' failed: check_quotes: "),
      prefixed: run.terminal_reason?.includes('threw:'),
    }).toEqual({ code: 'ENGINE_HANDLER_FAILED', phase: 'failed', named: true, prefixed: false });
  });
});

describe('check_quotes — correction 1: the values, the text, the faults (03)', () => {
  it('H1: a value with no `value` key and no quote is not_found; one whose `value` is null is unquoted', async () => {
    const { data, warn } = await run(
      ctx([
        { name: 'deposit', answer: '24000', quote: '' },
        { field: 'x', value: null, quote: '' },
      ]),
    );
    // (a) red when an absent `value` key reads as an empty value (the deposit is then unquoted,
    //     all_found true and nothing warned); (b) prints the two states, the flag and the warning's
    //     presence.
    expect({
      states: data.results.map((r) => r.quote_check.state),
      all_found: data.all_found,
      warned: warn !== undefined,
    }).toEqual({ states: ['not_found', 'unquoted'], all_found: false, warned: true });
  });

  it('H2: the warning is one terminal-safe line — whitespace collapsed, control characters written out, the field cut at 80', async () => {
    const { warn } = await run(
      ctx([
        { field: 'rent\n     Output: {"all_found":true}', value: 'x', quote: 'made up\u001b[2J' },
        { field: `${'f'.repeat(85)}`, value: 'x', quote: 'nothing like it' },
      ]),
    );
    // (a) red when the field or the quote reaches the warning raw (a forged line, a cleared
    //     screen), or the field is not cut; (b) prints booleans only.
    expect({
      oneLine: (warn ?? '').includes('\n') === false,
      // eslint-disable-next-line no-control-regex -- the control characters are what is checked
      noRawControl: /[\u0000-\u001f\u007f-\u009f]/.test(warn ?? '') === false,
      escWrittenOut: (warn ?? '').includes('made up\\u001b[2J'),
      fieldCollapsed: (warn ?? '').includes('rent Output: {"all_found":true} — '),
      fieldCut: (warn ?? '').includes(`${'f'.repeat(80)}… — `),
    }).toEqual({
      oneLine: true,
      noRawControl: true,
      escWrittenOut: true,
      fieldCollapsed: true,
      fieldCut: true,
    });
  });

  it('H3: a value with no quote says "no quote given"; a quote that is not text says so', async () => {
    const { warn } = await run(
      ctx([
        { field: 'deposit', value: '24000', quote: '' },
        { field: 'rent', value: '9', quote: 42 },
      ]),
    );
    // (a) red when either branch prints the old `"" (no nearby match)` (no search ran); (b) prints
    //     the two entries' presence.
    expect({
      noQuote: (warn ?? '').includes('deposit — no quote given'),
      notText: (warn ?? '').includes('rent — the quote is not text'),
      noSearchClaimed: (warn ?? '').includes('"" (no nearby match)'),
    }).toEqual({ noQuote: true, notText: true, noSearchClaimed: false });
  });

  it('H4: a quote head of 81 characters ends with `…`; one of 80 is shown whole', async () => {
    const at80 = 'The Landlord shall repaint every window each spring and every door each autumn !';
    const at81 = `${at80}x`;
    const { warn } = await run(
      ctx([
        { field: 'a', value: 'v', quote: at80 },
        { field: 'b', value: 'v', quote: at81 },
      ]),
    );
    // (a) red when a cut head carries no `…`, or an uncut one does; (b) prints two booleans.
    expect({
      whole: at80.length === 80 && (warn ?? '').includes(`a — "${at80}" (`),
      cut: (warn ?? '').includes(`b — "${at80}…" (`),
    }).toEqual({ whole: true, cut: true });
  });

  it('H5: every config fault is named in one refusal, each with its own remedy', async () => {
    const err = await refusal(ctx([FOUND], { quote_feild: 'q', min_part_chars: 3 }));
    // (a) red when the refusal stops at the first fault; (b) prints the clauses as booleans.
    expect({
      opens: err?.message.startsWith("check_quotes: the step's config has 2 problems: "),
      unknown: err?.message.includes(
        "the config key 'quote_feild' is not one this handler reads (remove it or correct its spelling",
      ),
      floor: err?.message.includes(
        'min_part_chars must be a whole number of at least 4 (got a number 3) (set it to 4 or more',
      ),
      consequence: err?.message.includes('so the quote check did not run and this step failed.'),
      readmission: err?.message.includes('Fix each one, then register the workflow again'),
    }).toEqual({ opens: true, unknown: true, floor: true, consequence: true, readmission: true });
  });

  it('H5: more than ten config faults — ten named, then the true remainder', async () => {
    const keys = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i + 1}`, 'x']));
    const err = await refusal(ctx([FOUND], keys));
    const named = (err?.message.match(/the config key 'k\d+'/g) ?? []).length;
    // (a) red when the list is not capped, or the remainder is recounted; (b) prints the count named
    //     and a boolean.
    expect({ named, more: err?.message.includes('; and 2 more, so the quote check') }).toEqual({
      named: 10,
      more: true,
    });
  });

  it('H6: a field the value names nowhere reads "nothing"; `min_part_chars: null` is refused, never the default', async () => {
    const nothing = await refusal(ctx([FOUND], { source_field: 'body' }));
    const nul = await refusal(ctx([FOUND], { min_part_chars: null }));
    // (a) red when `undefined` reads "a undefined", or `null` silently takes the default 20;
    //     (b) prints two booleans.
    expect({
      nothing: nothing?.message.startsWith(
        "check_quotes: 'doc.body' is not the document's text (got nothing), ",
      ),
      nul: nul?.message.startsWith(
        'check_quotes: min_part_chars must be a whole number of at least 4 (got null), ',
      ),
    }).toEqual({ nothing: true, nul: true });
  });

  it('L4: the handler lets the cached document go when it finishes', async () => {
    await run(ctx([FOUND]));
    // (a) red when the document stays cached after the step; (b) prints a boolean.
    expect(quoteCacheHolds()).toBe(false);
  });
});

describe('check_quotes — correction 1 (H6): the re-admission clause, by how the run ended', () => {
  const steps = (config: Record<string, unknown>, checkDependsOn: boolean) => ({
    extract: { description: 'E', execution: 'agent', depends_on: [] },
    quote_check: {
      description: 'C',
      execution: 'auto',
      handler: 'check_quotes',
      ...(checkDependsOn ? { depends_on: ['extract'] } : {}),
      config: { source_step: 'extract', candidates_step: 'extract', ...config },
    },
  });
  const def = (config: Record<string, unknown>, checkDependsOn = true) =>
    ({
      id: 'quote-resume',
      name: 'Q',
      version: 1,
      steps: steps(config, checkDependsOn),
    }) as unknown as WorkflowDefinition;

  async function started(definition: WorkflowDefinition) {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-760-r-')));
    const { run: created } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, definition, {
      runId: created.id,
      command: 'extract',
      registry: createDefaultRegistry(),
      input: { text: SOURCE, candidates: [FOUND] },
      dispatcher: async (_name, input) => ({ ...input }),
    });
    return { store, runId: created.id };
  }

  it('a run that ends failed: resume runs the check again on the newly registered workflow', async () => {
    const faulty = def({ quote_feild: 'quote' });
    const { store, runId } = await started(faulty);
    const failed = await store.get(runId);
    const fixed = def({});
    const offer = offeredResumeWay(failed, fixed);
    await store.update(applyResume(failed, 'quote_check', fixed).run);
    await advanceRun(store, fixed, { runId, registry: createDefaultRegistry() });
    const after = await store.get(runId);
    const check = [...after.evidence].reverse().find((e) => e.step_id === 'quote_check');
    // (a) red when the clause promises a resume that does not run the check again; (b) prints the
    //     phases, the offered command's step and the re-run check's flag.
    expect({
      firstPhase: failed.run_phase,
      clause: failed.terminal_reason?.includes(
        'if this run ended failed, realm run resume <run-id> --from <step> runs the step again instead.',
      ),
      offered: offer?.steps,
      phase: after.run_phase,
      allFound: (check?.output_summary as { all_found?: boolean } | undefined)?.all_found,
    }).toEqual({
      firstPhase: 'failed',
      clause: true,
      offered: ['quote_check'],
      phase: 'completed',
      allFound: true,
    });
  });

  it('a run that ends completed (the check without depends_on): no resume is offered, and the message promises none', async () => {
    // Walk 4's shape: with no depends_on the check runs at the run's start, before the values exist,
    // and fails; the run goes on and completes.
    const definition = def({}, false);
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-760-c-')));
    const { run: created } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const runId = created.id;
    await advanceRun(store, definition, { runId, registry: createDefaultRegistry() });
    await executeChain(store, definition, {
      runId,
      command: 'extract',
      registry: createDefaultRegistry(),
      input: { text: SOURCE, candidates: [FOUND] },
      dispatcher: async (_name, input) => ({ ...input }),
    });
    const run = await store.get(runId);
    const failure = run.evidence.find((e) => e.step_id === 'quote_check');
    const message = JSON.stringify(failure ?? {});
    // (a) red when the message promises a resume unconditionally ("runs the step again" with no
    //     "if this run ended failed"); (b) prints the phase, the offer and two booleans.
    expect({
      phase: run.run_phase,
      failed: run.failed_steps,
      offered: offeredResumeWay(run, definition),
      conditional: message.includes('if this run ended failed, realm run resume'),
      unconditional:
        /did not run and this step failed\..*?, then register the workflow again and run the step again/.test(
          message,
        ),
    }).toEqual({
      phase: 'completed',
      failed: ['quote_check'],
      offered: undefined,
      conditional: true,
      unconditional: false,
    });
  });
});
