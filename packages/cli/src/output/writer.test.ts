// #729 PR-3 (prompt 03 L-1, L-2; 04 "CLI"): the one writer of a CLI process. Every value is fake.
// Each assertion names (a) the change that turns it red and (b) what it prints on failure: booleans,
// counts and fake text, never a real value.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  disclose,
  respondWayOfGate,
  withFullStop,
  type PendingGate,
  type Unavailable,
} from '@sensigo/realm';
import {
  addDeclaredDisclosure,
  addDeclaredValues,
  CARRY_IDLE_MS,
  channelStdout,
  escapePassCut,
  installWriter,
  pass,
  printJsonByTable,
  questionSpan,
  RUN_PHASE_WORDS,
  writerCtx,
  writerReceiptLine,
  writerSetFor,
  writerTally,
  writerTestSeams,
} from './writer.js';
import { cannotRunClause, cliOperatorRoute, stopReasons } from '../commands/ways-renderer.js';
import { passedSnippet } from '../agent/providers/agent-utils.js';

const ENV_NAME = 'WRITER_FAKE_ENV_729';
const ENV_VALUE = 'FAKE-WRITER-ENV-0729';
const DECLARED_VALUE = 'FAKE-WRITER-DECL-0729';
const MARKS = /[\uE000-\uE002]/;

beforeEach(() => {
  // The vitest setup names every inherited variable not secret; these cells sweep on purpose.
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv(ENV_NAME, ENV_VALUE);
});
afterEach(() => {
  writerTestSeams.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Installs the writer with its writes captured (the original write is a spy taken first). */
function captured(mode: 'default' | 'broadcast' | 'mcp' = 'default') {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as never);
  installWriter(mode);
  addDeclaredValues({ SECRET: DECLARED_VALUE });
  return { out, err };
}

describe('#729 PR-3 — spans: a forged or replayed mark never exempts a value (9 cells × 3 kinds)', () => {
  const kinds = [
    ['c', 'a command'],
    ['q', 'question text'],
    ['d', 'table-built data'],
  ] as const;
  for (const [kind, label] of kinds) {
    it(`kind ${kind} (${label})`, () => {
      captured();
      const good = writerTestSeams.span(kind, `realm run inspect r1 --at ${ENV_VALUE}`);
      const stolenTag = good.slice(2, 24);
      const cases: Record<string, string> = {
        plainValueMasked: `Error: token ${ENV_VALUE} refused`,
        forgedMarksNoTag: `\uE000${ENV_VALUE}\uE002`,
        forgedMarksGuessedTag: `\uE000${kind}${'A'.repeat(22)}\uE001${ENV_VALUE}\uE002`,
        stolenTagOtherText: `\uE000${kind}${stolenTag}\uE001${ENV_VALUE}\uE002`,
        marksInsideTheValue: `${ENV_VALUE.slice(0, 5)}\uE001${ENV_VALUE.slice(5)}`,
        unterminatedStart: `\uE000${kind}${stolenTag}\uE001${ENV_VALUE} and on`,
        valueNextToSpan: `${ENV_VALUE}${good}${ENV_VALUE}`,
        replayedWholeSpan: `${good}${good}`,
      };
      const shown = Object.fromEntries(
        Object.entries(cases).map(([k, text]) => {
          const t = pass(text, 'log');
          // The value outside a verified span never shows; no mark ever leaves.
          const outside = t.split(`realm run inspect r1 --at ${ENV_VALUE}`).join('');
          return [k, { leaks: outside.includes(ENV_VALUE), marks: MARKS.test(t) }];
        }),
      );
      // (a) red when the writer exempts unverified text (a forged, guessed, stolen or unterminated
      //     span), leaves a mark, or masks around a span wrongly; (b) prints two booleans per case.
      expect(shown).toEqual(
        Object.fromEntries(Object.keys(cases).map((k) => [k, { leaks: false, marks: false }])),
      );
      // The verified span itself: a command and table data are shown as built; question text
      // keeps the environment value (declared tier, R2).
      // (a) red when a verified span is masked; (b) prints a boolean.
      expect(pass(good, 'log').includes(ENV_VALUE)).toBe(true);
    });
  }

  it('F26: a forged envelope between a credential name and its value still hides the value', () => {
    captured();
    const forged = `api_token=\uE000c${'A'.repeat(22)}\uE001FAKE-NAMED-VALUE-0729\uE002 end`;
    const shown = pass(forged, 'log');
    // (a) red when forged envelopes are no longer removed before the text is split (the value is
    //     read apart from its name, or shown as built); (b) prints the shown text (fake values).
    expect(shown).toBe('api_token=[REDACTED] end');
  });

  it('F26: a data span is walked with its marks removed first', () => {
    captured();
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
      logged.push(String(arg));
    });
    const split = `${ENV_VALUE.slice(0, 5)}\uE001${ENV_VALUE.slice(5)}`;
    printJsonByTable({ note: `x ${split}` }, { note: 'value' });
    const printed = pass(logged.join(''), 'log');
    // (a) red when the walk reads the value with the mark inside it (the mark parts the value, so
    //     the law misses it, and the span shows it whole); (b) prints two booleans.
    expect({ leaks: printed.includes(ENV_VALUE), marks: MARKS.test(printed) }).toEqual({
      leaks: false,
      marks: false,
    });
  });

  it('a question span hides a declared value and keeps an environment value (the declared tier)', () => {
    captured();
    const shown = pass(questionSpan(`Ship ${DECLARED_VALUE} to ${ENV_VALUE}?`), 'log');
    // (a) red when the question gets every tier, or skips the declared one; (b) prints the text.
    expect(shown).toBe(`Ship [REDACTED] to ${ENV_VALUE}?`);
  });
});

describe('#729 PR-3 — the composers pass the context; commands are whole, values are not', () => {
  const gate: PendingGate = {
    gate_id: 'g1',
    step_name: 'approve',
    preview: {},
    choices: [ENV_VALUE, 'reject'],
    opened_at: '2026-10-17T00:00:00.000Z',
  };

  it('stopReasons under listen (broadcast): a choice equal to an environment value rides its command whole', () => {
    captured('broadcast');
    const respond = respondWayOfGate('r1', gate);
    const line = stopReasons(
      { ways: [respond], unavailable: [] },
      'r1',
      'running',
      writerCtx(),
    )[0]!;
    const shown = pass(`${line}; and again ${ENV_VALUE}`, 'broadcast');
    // (a) red when the command is not one verified span (the choice inside it would be masked) or
    //     the value outside it shows; (b) prints booleans.
    expect({
      commandWhole: shown.includes(`--choice <one of: ${ENV_VALUE}, reject>`),
      outsideMasked: shown.endsWith('; and again [REDACTED]'),
      marks: MARKS.test(shown),
    }).toEqual({ commandWhole: true, outsideMasked: true, marks: false });
  });

  it('cannotRunClause on broadcast: the precondition value as its shape, never the stored refusal', () => {
    captured('broadcast');
    // The fact holds the value escaped (E1 (b)): a string with its quotes, a number as digits.
    const entry = (value: string) =>
      ({
        verb: 'run_step',
        step: 's',
        code: 'refused_before_claim',
        facts: {
          step: 's',
          check: 'precondition',
          refusal: `Precondition failed for step 's'. Precondition failed: 'a.x == 1'. Resolved value: ${value}.`,
          precondition: { expression: 'a.x == 1', value },
        },
        remedy: [],
      }) as unknown as Unavailable;
    const line = (shape: string) =>
      `'s' cannot run (precondition): Precondition failed for step 's'. Precondition failed: 'a.x == 1'. Resolved value: ${shape}.`;
    // (a) red when the line prints the stored `refusal` (the value's text), or shapes the escaped
    //     text instead of the value it escapes (F27: 29 characters with the quotes; a string for
    //     a number); (b) prints the lines.
    expect([
      pass(cannotRunClause(entry('"an ordinary FAKE value text"'), writerCtx()), 'broadcast'),
      pass(cannotRunClause(entry('3'), writerCtx()), 'broadcast'),
    ]).toEqual([line('‹string, 27 characters›'), line('‹number›')]);
  });

  it("the MCP person block's commands carry no mark even under the writer (PLAIN, I13)", () => {
    captured('mcp');
    const rendered = cliOperatorRoute('realm mcp').render(respondWayOfGate('r1', gate), undefined);
    // (a) red when the writer's context reaches cliOperatorRoute; (b) prints a boolean.
    expect(MARKS.test(rendered ?? '')).toBe(false);
  });
});

describe('#729 PR-3 — what the writer writes', () => {
  it('--json: ids and other facts stay as given, values are disclosed, one data span', () => {
    captured();
    // In a vitest worker `console.log` does not reach `process.stdout.write`, so the printed
    // argument is passed here the way the writer passes stdout in a CLI process.
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
      logged.push(String(arg));
    });
    printJsonByTable({ id: ENV_VALUE, note: `x ${ENV_VALUE}` }, { id: 'fact', note: 'value' });
    const json = JSON.parse(pass(logged.join(''), 'log')) as { id: string; note: string };
    // (a) red when an id is masked, a value is not, or the data span is not verified (the pass
    //     would mask the id); (b) prints the parsed object (fake values).
    expect(json).toEqual({ id: ENV_VALUE, note: 'x [REDACTED]' });
  });

  it("realm mcp: the channel's bytes leave as the serializer built them; a stray stdout write goes to the masked stderr", () => {
    const { out, err } = captured('mcp');
    channelStdout().write(`{"v":"${ENV_VALUE}"}\n`);
    process.stdout.write(`stray ${ENV_VALUE}\n`);
    // (a) red when the channel is masked or a stray write reaches stdout or leaves unmasked;
    //     (b) prints the captured lines (fake values).
    expect({ out, err }).toEqual({ out: [`{"v":"${ENV_VALUE}"}\n`], err: ['stray [REDACTED]\n'] });
  });

  it('one install per process: a second install patches nothing again', () => {
    captured();
    const write = process.stdout.write;
    const listeners = process.listenerCount('uncaughtException');
    installWriter('default');
    installWriter('broadcast');
    // (a) red when an install re-patches (writes would pass twice) or re-registers the handlers;
    //     (b) prints booleans and a count.
    expect({
      same: process.stdout.write === write,
      listeners: process.listenerCount('uncaughtException'),
    }).toEqual({
      same: true,
      listeners,
    });
  });

  it("the not-secret rule: REALM_NOT_SECRET ∪ every manifest's list, unless an unlisted variable holds the value", () => {
    vi.stubEnv('WRITER_A', 'FAKE-VALUE-AAAA-01');
    vi.stubEnv('WRITER_B', 'FAKE-VALUE-BBBB-02');
    vi.stubEnv('WRITER_C', 'FAKE-VALUE-CCCC-03');
    vi.stubEnv('REALM_NOT_SECRET', 'WRITER_A');
    captured();
    addDeclaredDisclosure({}, ['WRITER_B', 'WRITER_C']);
    addDeclaredDisclosure({}, ['WRITER_B']);
    const shown = (text: string) => pass(text, 'log');
    // (a) red when the lists combine by union (C would show), REALM_NOT_SECRET is ignored, or
    //     the shared-value rule is lost; (b) prints the texts (fake values).
    expect([
      shown('FAKE-VALUE-AAAA-01'),
      shown('FAKE-VALUE-BBBB-02'),
      shown('FAKE-VALUE-CCCC-03'),
    ]).toEqual(['FAKE-VALUE-AAAA-01', 'FAKE-VALUE-BBBB-02', '[REDACTED]']);
    // The shared-value rule: an unlisted variable holding the listed one's value keeps it hidden.
    // The writer builds its sets once per change of the declared part (F11), and a process's
    // environment does not change, so a process that starts with the copy is a fresh writer.
    vi.stubEnv('WRITER_COPY', 'FAKE-VALUE-AAAA-01');
    writerTestSeams.reset();
    captured();
    addDeclaredDisclosure({}, ['WRITER_B', 'WRITER_C']);
    expect(shown('FAKE-VALUE-AAAA-01')).toBe('[REDACTED]');
  });

  it('F32: a name REALM_NOT_SECRET lists that is not set gives one four-clause warning per process', () => {
    vi.stubEnv('REALM_NOT_SECRET', `${ENV_NAME},FAKE_UNSET_NAME_0729`);
    const { err } = captured();
    installWriter('broadcast');
    const warnings = err.filter((line) => line.includes('FAKE_UNSET_NAME_0729'));
    // (a) red when the warning is removed, repeated by a second install, or names a set variable;
    //     (b) prints the count and the warning (names only, never a value).
    expect({
      count: warnings.length,
      text: warnings[0],
      namesSet: warnings[0]?.includes(ENV_NAME),
    }).toEqual({
      count: 1,
      text:
        "Warning: REALM_NOT_SECRET lists 'FAKE_UNSET_NAME_0729', which is not set in this environment, so listing it has no effect. " +
        'Fix the name, or remove it from REALM_NOT_SECRET. Nothing else needs to change; a listed name takes effect once it is set.\n',
      namesSet: false,
    });
  });

  it('F16: the log-mode line says a shown question was masked at the declared tier only', () => {
    captured('broadcast');
    const before = writerReceiptLine();
    pass(questionSpan('Ship it?'), 'broadcast');
    // (a) red when the writer stops noting a shown question, or notes one with none shown; (b)
    //     prints two booleans.
    expect({
      before: before?.includes('question: declared tier only'),
      after: writerReceiptLine()?.endsWith('; question: declared tier only.'),
    }).toEqual({ before: false, after: true });
  });

  it('log mode: one receipt line counts what was hidden, by kind', () => {
    captured('broadcast');
    pass(`${ENV_VALUE} and ${DECLARED_VALUE} and password=FAKE-PW`, 'broadcast');
    // (a) red when a kind is not counted or a name is printed; (b) prints the line.
    expect(writerReceiptLine()).toBe(
      'Disclosure: declared values resolved; environment swept; hidden 1 declared, 1 environment, 1 by pattern; 0 not checked; 0 too short to hide; 0 values shown as their type and size.',
    );
    expect(writerSetFor('agent')?.sources.includes('declared:SECRET')).toBe(true);
  });

  it('C6: one value shown as its shape reads in the singular', () => {
    captured('broadcast');
    // One value shown as its type and size, on the log audience.
    writerCtx().value({ k: 1 });
    // (a) red when the count reads in the plural for one ("1 values shown as their type and
    //     size"); (b) prints the line's end.
    expect(writerReceiptLine()?.endsWith('; 1 value shown as its type and size.')).toBe(true);
  });
});

describe('#729 PR-3 — the CLI cuts: escape, pass, then cut (D3/08 S2)', () => {
  it("inspect's 120 and migrate's 80: a secret across the cut leaves no fragment; an ordinary value shows its passed start", () => {
    captured();
    const across = (cap: number) => `${'o'.repeat(cap - 6)}${ENV_VALUE}`;
    // (a) red when the cut comes before the pass (the value's start would show); (b) prints
    //     booleans and an `o` count.
    expect({
      at120: escapePassCut(across(120), 120).includes('FAKE'),
      at80: escapePassCut(across(80), 80).includes('FAKE'),
      ordinary: escapePassCut('o'.repeat(200), 120) === `${'o'.repeat(120)}…`,
    }).toEqual({ at120: false, at80: false, ordinary: true });
  });

  it('the provider snippets (200): the same order', () => {
    // No writer here: the provider edge builds its own agent set.
    const across = `${'o'.repeat(195)}${ENV_VALUE}`;
    // (a) red when a snippet is cut before it is passed; (b) prints booleans.
    expect({
      fragment: passedSnippet(across).includes('FAKE'),
      ordinary: passedSnippet('o'.repeat(300)) === `${'o'.repeat(200)}…`,
    }).toEqual({ fragment: false, ordinary: true });
  });
});

describe('#729 PR-3 — the fatal handler', () => {
  it('an uncaught error is written masked to stderr, and the process exits 1', () => {
    const dist = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'dist',
      'output',
      'writer.js',
    );
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const w = await import(${JSON.stringify(dist)}); w.installWriter('default'); throw new Error('boom ' + process.env.${ENV_NAME});`,
      ],
      { env: { PATH: process.env['PATH'] ?? '', [ENV_NAME]: ENV_VALUE }, encoding: 'utf8' },
    );
    // (a) red when the handler writes the raw error, or exits otherwise; (b) prints booleans and
    //     the exit code.
    expect({
      code: r.status,
      said: r.stderr.includes('Error: boom [REDACTED]'),
      leaked: r.stderr.includes(ENV_VALUE),
    }).toEqual({ code: 1, said: true, leaked: false });
  });
});

describe('#729 PR-3 — the abandon echo: the text between spans is masked as one text, the spans held fixed', () => {
  const RUN_ID = '0f8a2c1e-0000-4000-8000-000000000001';
  /** The echo's first line as `abandon.ts` builds it: the word spans, the reason as a value. */
  const sentence = (reason: string): string => {
    const ctx = writerCtx();
    return (
      `Run '${RUN_ID}' ${ctx.word('abandoned', RUN_PHASE_WORDS)} (phase: '${ctx.word('abandoned', RUN_PHASE_WORDS)}').` +
      ` Reason: ${withFullStop(ctx.value(reason))}\n`
    );
  };
  const tailOf = (echo: string): string =>
    echo.slice(echo.indexOf('Reason: ') + 'Reason: '.length).replace(/\n$/, '');
  const law = (text: string) => disclose(text, writerSetFor('log')!, 'all');
  const counts = () => {
    const t = writerTally()!;
    return t.declared + t.environment + t.pattern;
  };
  const REASONS = [
    "echo 'run password=Xk9' next",
    `'x Authorization: Bearer'" FAKEe1`,
    '{"a":"Authorization: Bearer FAKEe2"}',
    "token='FAKEe3\\\nFAKEe4\nFAKEe5' rest  refreshToken=Xk9' next",
  ];

  it("cell 1: the echo's Reason: tail is the law's reading of the reason with its full stop, byte for byte", () => {
    captured();
    const tails = REASONS.map((r) => tailOf(pass(sentence(r), 'log')));
    // (a) red when the text between spans is masked piece by piece again (texts 1, 2 and 4 differ;
    //     text 2 shows FAKEe1); (b) prints the echo's and the law's tails (fakes, markers) and a
    //     boolean.
    expect({ tails, credentialShown: tails[1]!.includes('FAKEe1') }).toEqual({
      tails: REASONS.map((r) => law(withFullStop(r)).text),
      credentialShown: false,
    });
  });

  it("cell 2 (a): the sentence's word spans come out as built, in place — a declared value equal to the word still shown", () => {
    captured();
    addDeclaredValues({ PHASE_WORD_729: 'abandoned' });
    const echo = pass(sentence("echo 'run password=Xk9' next"), 'log');
    // A span is realm's own word, shown whole even where a declared value equals it. (a) red when
    //     every line is masked whole with its spans inline (the words hidden); (b) prints the head.
    expect(echo.slice(0, echo.indexOf('Reason: '))).toBe(
      `Run '${RUN_ID}' abandoned (phase: 'abandoned'). `,
    );
  });

  it('cell 2 (c): adjacent spans stay two spans — both bodies as built, in order', () => {
    captured();
    const line =
      writerTestSeams.span('c', 'password=FAKEa1') +
      writerTestSeams.span('c', 'password=FAKEa2') +
      ' note';
    // (a) red when every span takes the same placeholder character (the second run does not match
    //     its span's placeholder, the line falls back and both bodies are masked); (b) prints the
    //     shown line.
    expect(pass(line, 'log')).toBe('password=FAKEa1password=FAKEa2 note');
  });

  it('cell 3 (a): a span inside a value run — the line is masked whole, the value hidden', () => {
    captured();
    // (a) red when the fallback shows the spans as built (`password=running`); (b) prints the line.
    expect(pass('password=' + writerTestSeams.span('c', 'running'), 'log')).toBe(
      'password=[REDACTED]',
    );
  });

  it('cell 3 (b): a span glued to a closing quote after a scheme word — the line is masked whole, the credential hidden', () => {
    captured();
    const out = pass(
      `'x Authorization: Bearer'${writerTestSeams.span('c', 'running')} FAKEs2`,
      'log',
    );
    // (a) red when the fallback shows the spans as built (`FAKEs2` shown), and (correction 1, cell 5)
    //     when the text's end is reached with the span unmatched and the disclosed input returned (the
    //     run swallowed whole, `FAKEs2` shown); (b) prints the line and a boolean.
    expect({ out, shown: out.includes('FAKEs2') }).toEqual({
      out: law(`'x Authorization: Bearer'running FAKEs2`).text,
      shown: false,
    });
  });

  it('cell 3 (c): the placeholders are chosen per line from characters the line does not hold', () => {
    captured();
    const planted = ' note ';
    // (a) red when the placeholder is a fixed character (the planted U+E003 reads as a second span,
    //     the line falls back and the body is masked); (b) prints the shown line.
    expect(pass(writerTestSeams.span('c', 'password=FAKEa3') + planted, 'log')).toBe(
      'password=FAKEa3' + planted,
    );
  });

  it("cell 3 (d): a span's line breaks are kept — a two-line body as built, the text after it masked", () => {
    captured();
    const line = writerTestSeams.span('c', 'password=FAKEa4\nline2') + '\ntoken=FAKEm1';
    // (a) red when a line break inside a body's core is matched as its placeholder (the match fails,
    //     the line falls back and the body is masked); (b) prints the shown line.
    expect(pass(line, 'log')).toBe('password=FAKEa4\nline2\ntoken=[REDACTED]');
  });

  it("cell 3 (d), the mask input: the body's line break stands at its place", () => {
    captured();
    const input = writerTestSeams.maskInput(
      writerTestSeams.span('c', 'password=FAKEa4\nline2') + '\ntoken=FAKEm1',
    )!;
    // (a) red when the body is flattened (its line break replaced by the placeholder); (b) prints
    //     the input's length, its line-break positions and its tail.
    expect({
      length: input.length,
      breaks: [...input].flatMap((c, i) => (c === '\n' ? [i] : [])),
      tail: input.slice(-13),
    }).toEqual({ length: 34, breaks: [15, 21], tail: 'token=FAKEm1'.padStart(13, '\n') });
  });

  it('cell 4: the tally counts one walk — the law on the reason alone, or the fallback walk alone', () => {
    captured();
    const reason = REASONS[3]!;
    const before = counts();
    pass(sentence(reason), 'log');
    const echoed = counts() - before;
    const h = law(withFullStop(reason)).hidden;
    const fallbackBefore = counts();
    pass('password=' + writerTestSeams.span('c', 'running'), 'log');
    const fallback = counts() - fallbackBefore;
    const fh = law('password=running').hidden;
    // (a) red when the placeholder walk's counts are added on a fallen-back line as well (doubled);
    //     (b) prints the counts.
    expect({ echoed, fallback }).toEqual({
      echoed: h.declared + h.environment + h.pattern,
      fallback: fh.declared + fh.environment + fh.pattern,
    });
  });

  // Correction 1 (C1-1): a span's run is matched against its body's shape — the breaks at its start
  // and end, its core code point by code point — never found by scanning for placeholder runs.
  it("correction 1, cell 1: a body's trailing line break is printed once", () => {
    captured();
    // (a) red when the body's trailing breaks are not consumed after its core (`abc\n\nx`);
    //     (b) prints the shown line (fake text).
    expect(pass(writerTestSeams.span('c', 'abc\n') + 'x', 'log')).toBe('abc\nx');
  });

  it("correction 1, cell 2: a body's leading line break is printed once", () => {
    captured();
    // (a) red when the body's leading breaks are not taken back out of the text before it
    //     (`x\n\nabc`); (b) prints the shown line (fake text).
    expect(pass('x' + writerTestSeams.span('c', '\nabc'), 'log')).toBe('x\nabc');
  });

  it("correction 1, cell 3: a multi-line body whose first line a value's run swallows — the line is masked whole", () => {
    captured();
    const out = pass(
      'token=' + writerTestSeams.span('c', 'password=FAKEc1\nline2') + ' tail',
      'log',
    );
    // (a) red when the spans are counted instead of matched (the second line's run passes as the
    //     span, the body printed after the marker, `FAKEc1` shown); (b) prints the line and a
    //     boolean.
    expect({ out, shown: out.includes('FAKEc1') }).toEqual({
      out: 'token=[REDACTED]\nline2 tail',
      shown: false,
    });
  });

  it('correction 1, cell 4: an interior CRLF in a body — the body as built, no fallback', () => {
    captured();
    const out = pass(writerTestSeams.span('c', 'password=FAKEc2\r\nline2') + ' ok', 'log');
    // (a) red when the match reads `\r` as a core character (mismatch, the fallback masks the body,
    //     `FAKEc2` hidden); (b) prints the line (fake text) and a boolean.
    expect({ out, shown: out.includes('FAKEc2') }).toEqual({
      out: 'password=FAKEc2\r\nline2 ok',
      shown: true,
    });
  });

  it('correction 1, cell 6: an astral character in a question body — one placeholder per code point, no fallback', () => {
    captured();
    const out = pass(writerTestSeams.span('q', 'is \u{1F600} password=FAKEu2 ok') + ' x', 'log');
    // (a) red when the core is matched by code units (two placeholders asked for the emoji, a
    //     mismatch, the fallback masks `FAKEu2` at the line's tier); (b) prints the line (fake text).
    expect(out).toBe('is \u{1F600} password=FAKEu2 ok x');
  });

  it("correction 1, cell 7: a question span's declared read stays on its full body, line breaks included", () => {
    captured();
    addDeclaredValues({ DECL_NL_729: 'FAKEDECLRnl\n' });
    const withBreak = pass('Q: ' + writerTestSeams.span('q', 'ask FAKEDECLRnl\n') + 'x', 'log');
    addDeclaredValues({ DECL_729: 'FAKEDECLR' });
    const without = pass('Q: ' + writerTestSeams.span('q', 'ask FAKEDECLR\n') + 'x', 'log');
    // (a) red when the question is read at the declared tier on its core without the edge breaks
    //     (the value with its newline not matched, `FAKEDECLRnl` shown); (b) prints the two lines
    //     (fake text).
    expect({ withBreak, without }).toEqual({
      withBreak: 'Q: ask [REDACTED]x',
      without: 'Q: ask [REDACTED]\nx',
    });
  });
});

// F2 (B2): the writer's set passes the working directory — a variable holding it is never a
// member, so a path under it prints whole on a log. Fakes only (a folder that does not exist).
describe('F2 — the working directory (B2, writer.ts setFor)', () => {
  const F2_CWD = '/srv/fake-f2-project-01';
  it("a log shows a path under the working directory whole although INIT_CWD and npm's prefix hold it", () => {
    vi.spyOn(process, 'cwd').mockReturnValue(F2_CWD);
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('INIT_CWD', F2_CWD);
    vi.stubEnv('npm_config_local_prefix', F2_CWD);
    captured();
    const line = `Move it to '${F2_CWD}/realm.yaml'.`;
    // (a) red when the writer's set is built without `cwd` (the folder reads [REDACTED]); (b)
    //     prints the fake line.
    expect(pass(line, 'log')).toBe(line);
  });
});

// U1: the writer carries across writes on a log — a value printed in pieces is hidden as one.
// Both streams read as a log in a vitest worker (`isTTY` unset); the cells take `k` from the set at
// run time. Every value is fake.
describe('U1 — the writer carries across writes on a log', () => {
  /** 29 characters, declared; a plain value with no prefix form. */
  const V = 'CANARY-declared-u1-0000000001';

  /** Installs the writer with both streams captured into one ordered list (the originals are spies
   *  taken first), and the fake declared. */
  function carried(mode: 'default' | 'broadcast' | 'mcp' = 'default') {
    const all: Array<['out' | 'err', string]> = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      all.push(['out', String(chunk)]);
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      all.push(['err', String(chunk)]);
      return true;
    }) as never);
    installWriter(mode);
    addDeclaredValues({ U1_TOKEN: V });
    const of = (stream: 'out' | 'err'): string[] =>
      all.filter(([s]) => s === stream).map(([, t]) => t);
    return {
      all,
      chunks: () => of('out'),
      out: () => of('out').join(''),
      err: () => of('err').join(''),
      k: writerSetFor('log')!.maxFormLength - 1,
    };
  }

  it('U1-1 two writes on one line: the value is hidden as one (a declared value, an environment value)', () => {
    const c = carried();
    process.stdout.write('split: ' + V.slice(0, 10));
    process.stdout.write(V.slice(10) + ' end\n');
    process.stdout.write('env: ' + ENV_VALUE.slice(0, 7));
    process.stdout.write(ENV_VALUE.slice(7) + ' end\n');
    // (a) red when each write is masked alone (main 772c0904: both values whole in the log); (b)
    //     prints the captured text (fakes).
    expect({
      text: c.out(),
      whole: c.out().includes(V) || c.out().includes(ENV_VALUE),
    }).toEqual({
      text: 'split: [REDACTED] end\nenv: [REDACTED] end\n',
      whole: false,
    });
  });

  it('U1-2 every cut: two writes read as the one write', () => {
    const c = carried();
    process.stdout.write('split: ' + V + ' end\n');
    const oneWrite = c.out();
    const differ: Array<{ i: number; text: string }> = [];
    for (let i = 1; i < V.length; i++) {
      const from = c.out().length;
      process.stdout.write('split: ' + V.slice(0, i));
      process.stdout.write(V.slice(i) + ' end\n');
      const text = c.out().slice(from);
      if (text !== oneWrite) differ.push({ i, text });
    }
    // (a) red when a cut at any `i` lets a piece through (main 772c0904: every `i`); (b) prints the
    //     one-write text and each failing `i` with its captured text (the fake).
    expect({ oneWrite, differ }).toEqual({ oneWrite: 'split: [REDACTED] end\n', differ: [] });
  });

  it('U1-3 control: one write is hidden and counted once', () => {
    const c = carried();
    process.stdout.write('whole: ' + V + ' end\n');
    // (a) red when the carry counts a hide twice (the raw text passed a second time); (b) prints
    //     the captured text and a count.
    expect({ text: c.out(), declared: writerTally()!.declared }).toEqual({
      text: 'whole: [REDACTED] end\n',
      declared: 1,
    });
  });

  it('U1-4 a write that ends with a line break holds nothing back', () => {
    const c = carried();
    const line = 'abc' + 'm'.repeat(c.k + 10) + 'xyz\n';
    process.stdout.write(line);
    // (a) red when the carry keeps the last `k` units whatever the line break; (b) prints the held
    //     text's length and two booleans.
    expect({
      held: writerTestSeams.carry('stdout').length,
      whole: c.out() === line,
      endsWithLine: c.out().endsWith('xyz\n'),
    }).toEqual({ held: 0, whole: true, endsWithLine: true });
  });

  it('U1-5 the interleave: a stderr line never lands inside a stdout line', () => {
    const c = carried();
    process.stdout.write('line one ends\n');
    process.stderr.write('⚠ warn\n');
    process.stdout.write('line two\n');
    // (a) red when a line-terminated write is held (the carry keeps the last `k` units whatever the
    //     line break); (b) prints the captured writes in order (no value).
    expect(c.all).toEqual([
      ['out', 'line one ends\n'],
      ['err', '⚠ warn\n'],
      ['out', 'line two\n'],
    ]);
  });

  it("U1-5b a held unfinished line lets the other stream's line come first; the value is still hidden as one", () => {
    const c = carried();
    process.stdout.write('split: ' + V.slice(0, 10));
    process.stderr.write('⚠ warn\n');
    process.stdout.write(V.slice(10) + ' end\n');
    // (a) red under the break "a write on one stream flushes the other stream's held tail first"
    //     (in patch, before the take: flush(stream === 'stdout' ? 'stderr' : 'stdout', 'idle')): the
    //     order becomes out-partial, err, out-rest and the value shows in pieces; U1-1 and U1-5 stay
    //     green under it, so this cell alone carries the order; (b) prints the captured writes in
    //     order (the fake).
    expect(c.all).toEqual([
      ['err', '⚠ warn\n'],
      ['out', 'split: [REDACTED] end\n'],
    ]);
  });

  it('U1-6 the idle flush: an unfinished line shows after CARRY_IDLE_MS, on an unref’d timer', () => {
    vi.useFakeTimers();
    try {
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const c = carried();
      process.stdout.write('Choice [yes/no]: ');
      const call = timers.mock.calls.findIndex((args) => args[1] === CARRY_IDLE_MS);
      const handle = timers.mock.results[call]?.value as NodeJS.Timeout | undefined;
      const atOnce = c.out();
      vi.advanceTimersByTime(CARRY_IDLE_MS - 1);
      const justBefore = c.out();
      vi.advanceTimersByTime(1);
      // (a) red when there is no idle timer (the prompt is never emitted) or the timer is not
      //     unref'd (it would hold the process open); (b) prints what was emitted when, and a boolean.
      expect({
        idleMs: CARRY_IDLE_MS,
        atOnce,
        justBefore,
        atIdle: c.out(),
        hasRef: handle?.hasRef(),
      }).toEqual({
        idleMs: 200,
        atOnce: '',
        justBefore: '',
        atIdle: 'Choice [yes/no]: ',
        hasRef: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('U1-7 the fatal and exit flushes (spawned): the held tail before the error, and at a normal exit', () => {
    const dist = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'dist',
      'output',
      'writer.js',
    );
    // A long fake environment value makes `k` at least 64 in the child.
    const env = { PATH: process.env['PATH'] ?? '', U1_LONG_FAKE: `FAKE-u1-long-${'L'.repeat(60)}` };
    const child = (code: string) =>
      spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const w = await import(${JSON.stringify(dist)}); w.installWriter('default'); ${code}`,
        ],
        { env, encoding: 'utf8' },
      );
    const thrown = child(
      "process.stdout.write('out tail FAKE'); process.stderr.write('err tail FAKE'); throw new Error('boom u1');",
    );
    const tailAt = thrown.stderr.indexOf('err tail FAKE');
    const errorAt = thrown.stderr.indexOf('Error: boom u1');
    const exited = child("process.stdout.write('exit tail FAKE');");
    // (a) red when `fatal` does not flush first (the tail after the error, or missing) or there is
    //     no 'exit' listener (the tail lost at a normal exit); (b) prints the exit codes, the
    //     children's captured output (fakes and paths only) and the order.
    expect(
      {
        thrownCode: thrown.status,
        thrownOut: thrown.stdout,
        tailBeforeError: tailAt >= 0 && errorAt > tailAt,
        exitedCode: exited.status,
        exitedOut: exited.stdout,
      },
      `thrown stderr: ${thrown.stderr}`,
    ).toEqual({
      thrownCode: 1,
      thrownOut: 'out tail FAKE',
      tailBeforeError: true,
      exitedCode: 0,
      exitedOut: 'exit tail FAKE',
    });
  });

  it("U1-7b the seam's reset writes a held tail through the original and removes the 'exit' listener", () => {
    const listeners = process.listenerCount('exit');
    const c = carried();
    process.stdout.write('reset tail');
    const held = writerTestSeams.carry('stdout');
    const installed = process.listenerCount('exit') - listeners;
    writerTestSeams.reset();
    // (a) red when `reset` neither flushes nor removes the listener (listeners accumulate per
    //     test); (b) prints the held text, the output and two counts.
    expect({
      held,
      installed,
      out: c.out(),
      afterReset: process.listenerCount('exit') - listeners,
    }).toEqual({ held: 'reset tail', installed: 1, out: 'reset tail', afterReset: 0 });
  });

  it('U1-8 a surrogate pair at the cut stays whole', () => {
    const c = carried();
    const i = 10;
    // The low half of 😀 sits exactly `k` units from the first write's end: the naive cut parts it.
    const head = 'astral: 😀' + 'y'.repeat(c.k - 1 - i);
    process.stdout.write(head + V.slice(0, i));
    process.stdout.write(V.slice(i) + ' end\n');
    const chunks = c.chunks();
    const units = chunks.map((t) => t.charCodeAt(t.length - 1).toString(16)).join(',');
    // (a) red when the cut parts a pair (a chunk ends with a lone high half: its UTF-8 bytes read
    //     back as U+FFFD); (b) prints the code units at each chunk's end and two booleans.
    expect(
      {
        wellFormed: chunks.every((t) => Buffer.from(t, 'utf8').toString('utf8') === t),
        text: c.out() === head + '[REDACTED] end\n',
      },
      `last units: ${units}`,
    ).toEqual({ wellFormed: true, text: true });
  });

  it('U1-9 realm mcp: the channel is written at once; a stray stdout write carries on stderr', () => {
    const c = carried('mcp');
    channelStdout().write('x');
    const channel = [...c.all];
    process.stdout.write('stray partial');
    const strayHeld = writerTestSeams.carry('stderr');
    process.stderr.write(' done\n');
    // (a) red when the channel goes through the patched write (it would be diverted and held); (b)
    //     prints the captured writes and the held text (no value).
    expect({ channel, strayHeld, stray: c.err(), out: c.out() }).toEqual({
      channel: [['out', 'x']],
      strayHeld: 'stray partial',
      stray: 'stray partial done\n',
      out: 'x',
    });
  });

  it('U1-9b a terminal carries nothing', () => {
    const saved = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    try {
      const c = carried();
      process.stdout.write('typed: ab');
      // (a) red when the carry runs on a terminal (each echoed key would wait); (b) prints the
      //     output and the held text (no value).
      expect({ out: c.out(), held: writerTestSeams.carry('stdout') }).toEqual({
        out: 'typed: ab',
        held: '',
      });
    } finally {
      writerTestSeams.reset();
      if (saved !== undefined) Object.defineProperty(process.stdout, 'isTTY', saved);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('U1-10b the nested-member limit, pinned as it is: cut after the inner value ends, the rest of the outer shows', () => {
    const HOST = 'https://api.FAKE-u1.example';
    const HOOK = `${HOST}/hook/FAKESECRET123`;
    vi.stubEnv('U1_HOST_FAKE', HOST);
    const c = carried();
    addDeclaredValues({ U1_HOOK: HOOK });
    const shown = (cut?: number): string => {
      const from = c.out().length;
      if (cut === undefined) process.stdout.write('cut: ' + HOOK + ' end\n');
      else {
        process.stdout.write('cut: ' + HOOK.slice(0, cut));
        process.stdout.write(HOOK.slice(cut) + ' end\n');
      }
      return c.out().slice(from);
    };
    // (a) case 1, one write: hidden on both trees. Case 2, the cut before the inner value ends:
    //     whole on main, hidden with the carry — the carry's own work, red with no carry. Case 3,
    //     the cut after the inner value ends: the inner hidden and the outer's rest shown on both
    //     trees — the nested-member limit (Part G item 10), red under "hold the RAW tail" (the
    //     break not taken: without match positions a complete member across the cut would show),
    //     the pin that flips on purpose when match positions arrive (U2); (b) prints the three
    //     outputs (fakes).
    expect({
      oneWrite: shown(),
      beforeHostEnds: shown(10),
      afterHostEnds: shown(HOST.length),
    }).toEqual({
      oneWrite: 'cut: [REDACTED] end\n',
      beforeHostEnds: 'cut: [REDACTED] end\n',
      afterHostEnds: 'cut: [REDACTED]/hook/FAKESECRET123 end\n',
    });
  });

  it("U1-9c a span in a write's trailing partial line is not held: its body shows as built", () => {
    vi.stubEnv('HOME', '/home/FAKE-u1-home');
    const c = carried();
    const body = 'realm run inspect /home/FAKE-u1-home/x';
    process.stdout.write('next: ' + writerTestSeams.span('c', body));
    // (a) red when the carry holds a partial line that holds a span (the re-pass would read the
    //     body as plain text: `[REDACTED]/x`); (b) prints the output, the held text and the plain
    //     text's pass (fake paths).
    expect({
      out: c.out(),
      held: writerTestSeams.carry('stdout'),
      plain: pass('at /home/FAKE-u1-home/x', 'log'),
    }).toEqual({ out: 'next: ' + body, held: '', plain: 'at [REDACTED]/x' });
  });

  it('U1-14 a carriage return ends the held line: a redrawn frame is written when the next frame begins', () => {
    const c = carried();
    process.stdout.write('\rframe-one');
    process.stdout.write('\rframe-two');
    // (a) red under E-cr-boundary (both expressions back to '\n' only): held 20, out '' — the whole
    //     20 units wait for the idle timer; (b) prints the held length and the written text.
    expect({ held: writerTestSeams.carry('stdout').length, out: c.out() }).toEqual({
      held: 9,
      out: '\rframe-one\r',
    });
  });
});
