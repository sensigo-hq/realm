// #729 PR-3 (RECORD 01 #6; D1 §3.2): the class-table walk. Every value is fake. Each assertion names
// (a) the change that turns it red and (b) what it prints on failure: shown values are fake values,
// markers and shapes only.
import { describe, it, expect } from 'vitest';
import { compileDisclosure, disclose, markersIn, type DisclosureAudience } from './redaction.js';
import { discloseByTable, discloseValue, shapeOf, type ClassTable } from './disclosure-walk.js';

const ENV_VALUE = 'FAKE-ENV-VALUE-0001';
const DECLARED_VALUE = 'FAKE-DECLARED-0002';

function setFor(audience: DisclosureAudience) {
  return compileDisclosure(
    [
      { value: ENV_VALUE, source: 'env:A' },
      { value: DECLARED_VALUE, source: 'declared:B' },
    ],
    { declared: 'resolved', audience, environment: 'swept' },
  ).set;
}

const TABLE: ClassTable = {
  id: 'fact',
  data: 'value',
  ask: 'question',
  error: 'bounded',
  frozen: 'frozen',
  inner: { nested: { name: 'fact', secret: 'value' } },
  byStep: { map: { note: 'value', step: 'fact' } },
  kinded: {
    nested: (v) =>
      (v as { kind?: string }).kind === 'a'
        ? { kind: 'fact', a: 'value' }
        : { kind: 'fact', b: 'fact' },
  },
};

const INPUT = {
  id: ENV_VALUE,
  data: { text: `x ${ENV_VALUE} ${DECLARED_VALUE}`, n: 7, list: [ENV_VALUE] },
  ask: `Approve ${ENV_VALUE} and ${DECLARED_VALUE}?`,
  error: `failed with ${ENV_VALUE}`,
  frozen: DECLARED_VALUE,
  inner: { name: ENV_VALUE, secret: DECLARED_VALUE },
  byStep: { [`step_${ENV_VALUE}`]: { note: ENV_VALUE, step: ENV_VALUE } },
  kinded: { kind: 'a', a: ENV_VALUE },
};
/** INPUT as it was written, before any cell walked it: a walk that writes into its input would
 *  leave the shared object already shown. */
const INPUT_JSON = JSON.stringify(INPUT);

describe('#729 PR-3 — discloseByTable', () => {
  it('agent: facts as they are, values and diagnostics every tier, the question the declared tier only', () => {
    const { value } = discloseByTable(INPUT, TABLE, setFor('agent'), 'agent');
    // (a) red when a row's class is ignored (a fact masked, a value or a bounded field shown, the
    //     question given every tier, a map key or a nested table's fact masked); (b) prints the
    //     shown object (fake values and markers).
    expect(value).toEqual({
      id: ENV_VALUE,
      data: { text: 'x [REDACTED] [REDACTED]', n: 7, list: ['[REDACTED]'] },
      ask: `Approve ${ENV_VALUE} and [REDACTED]?`,
      error: 'failed with [REDACTED]',
      frozen: DECLARED_VALUE,
      inner: { name: ENV_VALUE, secret: '[REDACTED]' },
      byStep: { [`step_${ENV_VALUE}`]: { note: '[REDACTED]', step: ENV_VALUE } },
      kinded: { kind: 'a', a: '[REDACTED]' },
    });
  });

  it('broadcast: value leaves become their shapes; the question and diagnostics are masked, never shaped', () => {
    const { value, tally } = discloseByTable(INPUT, TABLE, setFor('broadcast'), 'broadcast');
    const shown = value as typeof INPUT;
    // (a) red when broadcast stops shaping a value, or shapes free text; (b) prints shapes and text.
    expect(shown.data).toEqual({
      text: `‹string, ${INPUT.data.text.length} characters›`,
      n: '‹number›',
      list: [`‹string, ${ENV_VALUE.length} characters›`],
    });
    expect(shown.ask).toBe(`Approve ${ENV_VALUE} and [REDACTED]?`);
    expect(shown.error).toBe('failed with [REDACTED]');
    expect(tally.shaped).toEqual([
      'data',
      'inner.secret',
      `byStep.step_${ENV_VALUE}.note`,
      'kinded.a',
    ]);
  });

  it('private: the declared tier everywhere, nothing shaped', () => {
    const { value } = discloseByTable(INPUT, TABLE, setFor('private'), 'private');
    const shown = value as typeof INPUT;
    // (a) red when private gets the environment tier; (b) prints the shown fields.
    expect(shown.data.text).toBe(`x ${ENV_VALUE} [REDACTED]`);
    expect(shown.error).toBe(`failed with ${ENV_VALUE}`);
  });

  it('the input is never changed', () => {
    // A fresh copy of INPUT as written (the cells above walked the shared object).
    const input = JSON.parse(INPUT_JSON) as typeof INPUT;
    const before = JSON.stringify(input);
    discloseByTable(input, TABLE, setFor('agent'), 'agent');
    // (a) red when the walk writes into its input; (b) prints a boolean.
    expect(JSON.stringify(input) === before).toBe(true);
  });

  it('an unclassified key is walked as a value and reported to onUnclassified', () => {
    const seen: string[] = [];
    const { value } = discloseByTable(
      { id: 'r1', extra: ENV_VALUE },
      { id: 'fact' },
      setFor('agent'),
      'agent',
      {
        onUnclassified: (path) => seen.push(path),
      },
    );
    // (a) red when an unknown key is shown as it is, or not reported; (b) prints the paths and value.
    expect(seen).toEqual(['extra']);
    expect(value).toEqual({ id: 'r1', extra: '[REDACTED]' });
  });

  it('a number whose JSON text holds a member is hidden whole; the result still parses', () => {
    const set = compileDisclosure([{ value: '12345678', source: 'env:N' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const { value } = discloseByTable({ v: { n: 12345678, m: 5 } }, { v: 'value' }, set, 'agent');
    // (a) red when numbers are skipped; (b) prints the object.
    expect(value).toEqual({ v: { n: '[REDACTED]', m: 5 } });
  });

  it('a key holding a member is masked like any string', () => {
    const { value } = discloseByTable(
      { v: { [ENV_VALUE]: 1 } },
      { v: 'value' },
      setFor('agent'),
      'agent',
    );
    // (a) red when keys are not walked; (b) prints the keys.
    expect(Object.keys((value as { v: object }).v)).toEqual(['[REDACTED]']);
  });

  it('a cycle and an over-deep value are shown as shapes, never followed', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    let deep: Record<string, unknown> = { leaf: ENV_VALUE };
    for (let i = 0; i < 80; i++) deep = { d: deep };
    const { value } = discloseByTable(
      { c: cyclic, d: deep },
      { c: 'value', d: 'value' },
      setFor('agent'),
      'agent',
    );
    const shown = value as { c: Record<string, unknown>; d: unknown };
    // (a) red when a cycle recurses (a stack overflow) or depth is unbounded; (b) prints the shapes
    //     and a boolean.
    expect(shown.c['self']).toBe('‹cycle›');
    expect(JSON.stringify(shown.d).includes('‹object, 1 key›')).toBe(true);
    expect(JSON.stringify(shown.d).includes(ENV_VALUE)).toBe(false);
  });

  it('discloseValue: one value as the audience sees it', () => {
    // (a) red when the audience is ignored; (b) prints the shown value.
    expect(discloseValue({ a: ENV_VALUE }, setFor('broadcast'), 'broadcast').value).toEqual({
      a: `‹string, ${ENV_VALUE.length} characters›`,
    });
    expect(discloseValue({ a: ENV_VALUE }, setFor('agent'), 'agent').value).toEqual({
      a: '[REDACTED]',
    });
  });

  it('shapeOf: a type and a size, never content', () => {
    // (a) red when a shape carries content; (b) prints the shapes.
    expect([
      shapeOf('abc'),
      shapeOf(1),
      shapeOf(true),
      shapeOf([1, 2]),
      shapeOf({ a: 1, b: 2 }),
      shapeOf(null),
    ]).toEqual([
      '‹string, 3 characters›',
      '‹number›',
      '‹boolean›',
      '‹array, 2 items›',
      '‹object, 2 keys›',
      null,
    ]);
  });

  it('shapeOf: one of a kind reads in the singular, and stays a named marker (F27)', () => {
    const set = compileDisclosure([{ value: 'character', source: 'env:A' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const shapes = [shapeOf('a'), shapeOf([1]), shapeOf({ a: 1 })];
    // (a) red when a count of one reads in the plural, or a singular shape is not a named marker (a
    //     member inside it would be masked); (b) prints the shapes and what a pass shows of them.
    expect({
      shapes,
      passed: shapes.map((x) => disclose(`a ${String(x)} b`, set, 'all').text),
    }).toEqual({
      shapes: ['‹string, 1 character›', '‹array, 1 item›', '‹object, 1 key›'],
      passed: ['a ‹string, 1 character› b', 'a ‹array, 1 item› b', 'a ‹object, 1 key› b'],
    });
  });
});

describe('#729 PR-3 correction 1 — the walk (F7, F15, F25, F27)', () => {
  it("F7: a leaf whose JSON-escaped spelling holds a member is hidden whole, at the leaf's own tier", () => {
    // A value with a literal `\n` that ends in a lone `\` (the A1 value): printed with its `\n`
    // read, only the escaped spelling of the printed text holds it.
    const BS = '\\';
    const VALUE = 'FAKEtb' + BS + 'n' + 'line2x9' + BS;
    const PRINTED = 'FAKEtb' + '\n' + 'line2x9' + BS;
    const set = compileDisclosure([{ value: VALUE, source: 'env:A1' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const { value } = discloseByTable(
      { out: PRINTED, also: `${PRINTED} and ${VALUE}`, ask: PRINTED },
      { out: 'value', also: 'value', ask: 'question' },
      set,
      'agent',
    );
    const shown = value as { out: string; also: string; ask: string };
    // (a) red when the masked-string check is removed (the value shows on the wire), or it runs at
    //     every tier (a question, the declared tier only, would hide an environment value: P-9);
    //     (b) prints the shown values' markers and a boolean.
    expect({ out: shown.out, also: shown.also, askKept: shown.ask === PRINTED }).toEqual({
      out: '[REDACTED]',
      also: '[REDACTED]',
      askKept: true,
    });
  });

  it('F15: a credential name hiding a declared value counts as declared', () => {
    const { tally } = discloseByTable(
      { v: { password: DECLARED_VALUE } },
      { v: 'value' },
      setFor('agent'),
      'agent',
    );
    // (a) red when the hide counts as a pattern whatever it hid; (b) prints the counts.
    expect(tally.hidden).toEqual({ declared: 1, environment: 0, pattern: 0 });
  });

  it('F15: a subtree past the depth limit is counted in too_deep on log, not only on broadcast', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 80; i++) deep = { d: deep };
    const { tally } = discloseByTable({ d: deep }, { d: 'value' }, setFor('log'), 'log');
    // (a) red when depth shapes are counted on broadcast only; (b) prints two counts.
    expect({ tooDeep: tally.tooDeep, shaped: tally.shapedCount }).toEqual({
      tooDeep: 1,
      shaped: 1,
    });
  });

  it('F25: two keys that are wholly members stay two keys; a boolean under a credential name stays a boolean', () => {
    const { value } = discloseByTable(
      { v: { [ENV_VALUE]: 1, [DECLARED_VALUE]: 2 }, flags: { password: true, token: false } },
      { v: 'value', flags: 'value' },
      setFor('agent'),
      'agent',
    );
    // (a) red when the second key collapses into the first (no `#2` suffix), or a boolean under a
    //     credential name is masked; (b) prints the shown objects (markers and booleans).
    expect(value).toEqual({
      v: { '[REDACTED]': 1, '[REDACTED]#2': 2 },
      flags: { password: true, token: false },
    });
  });

  it('F27 (re-aimed, PR3-R2-L1-18): on broadcast one of a kind reads in the singular, and each shape is a named marker', () => {
    const { value } = discloseByTable(
      { v: { s: 'x', list: [1], one: { k: 1 }, n: 3 } },
      { v: 'value' },
      setFor('broadcast'),
      'broadcast',
    );
    // (a) red when the singular is not a named marker (`markersIn` misses it, so a later pass would
    //     mask inside it) — round 1 read `‹string, 1 characters›`; (b) prints the shapes.
    expect({ value, markers: markersIn(value).sort() }).toEqual({
      value: {
        v: {
          s: '‹string, 1 character›',
          list: ['‹number›'],
          one: { k: '‹number›' },
          n: '‹number›',
        },
      },
      markers: ['‹number›', '‹string, 1 character›'],
    });
  });
});

describe('#729 PR-3 correction 2 — the walk (E-6’, E-8, E-9)', () => {
  it("E-6': under a key named `pwd` alone, a path shows and anything else is hidden", () => {
    const { value, tally } = discloseByTable(
      { v: { Pwd: 'FAKEodbc9x', PWD: '/srv/app', pwd: 7 } },
      { v: 'value' },
      setFor('agent'),
      'agent',
    );
    // (a) red when the walk's key rule ignores the value (the ODBC password and the number show);
    //     (b) prints the shown values and a count.
    expect({ value, pattern: tally.hidden.pattern }).toEqual({
      value: { v: { Pwd: '[REDACTED]', PWD: '/srv/app', pwd: '[REDACTED]' } },
      pattern: 2,
    });
  });

  it('E-8: a key whose JSON-escaped spelling holds a member is hidden, and the member is listed on private', () => {
    // The A1 value: a literal `\n` and a trailing `\`; the key holds it with its `\n` read.
    const BS = '\\';
    const VALUE = 'FAKEkey' + BS + 'n' + 'line2x9' + BS;
    const KEY = 'FAKEkey' + '\n' + 'line2x9' + BS;
    const set = compileDisclosure([{ value: VALUE, source: 'declared:K' }], {
      declared: 'resolved',
      audience: 'private',
      environment: 'swept',
    }).set;
    const { value, tally } = discloseByTable({ v: { [KEY]: 1 } }, { v: 'value' }, set, 'private');
    // (a) red when keys skip the escaped-spelling check (the key shows on the wire); (b) prints the
    //     shown keys and the members listed.
    expect({ keys: Object.keys((value as { v: object }).v), members: [...tally.members] }).toEqual({
      keys: ['[REDACTED]'],
      members: ['declared:K'],
    });
  });

  it('E-9: a credential-named value with no JSON text (a cycle, a bigint) is hidden and counted, never thrown', () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const run = () =>
      discloseByTable(
        { v: { password: cycle, token: { n: 1n } } },
        { v: 'value' },
        setFor('agent'),
        'agent',
      );
    // (a) red when JSON.stringify's throw escapes (the walk throws); (b) prints the shown values
    //     and a count.
    const { value, tally } = run();
    expect({ value, pattern: tally.hidden.pattern }).toEqual({
      value: { v: { password: '[REDACTED]', token: '[REDACTED]' } },
      pattern: 2,
    });
  });
});

describe('#729 PR-3 correction 3 — the walk (H-5)', () => {
  it('H-5: a string leaf whose JSON-escaped spelling holds a member is hidden, and the member is listed on private', () => {
    const BS = '\\';
    const VALUE = 'FAKEleaf' + BS + 'n' + 'line2x9' + BS;
    const LEAF = 'FAKEleaf' + '\n' + 'line2x9' + BS;
    const set = compileDisclosure([{ value: VALUE, source: 'declared:L' }], {
      declared: 'resolved',
      audience: 'private',
      environment: 'swept',
    }).set;
    const { value, tally } = discloseByTable({ v: { note: LEAF } }, { v: 'value' }, set, 'private');
    // (a) red when a leaf's escaped-spelling hide lists no member (keys only); (b) prints the shown
    //     value, a count and the members listed.
    expect({
      value,
      declared: tally.hidden.declared,
      members: [...tally.members],
    }).toEqual({ value: { v: { note: '[REDACTED]' } }, declared: 1, members: ['declared:L'] });
  });
});
