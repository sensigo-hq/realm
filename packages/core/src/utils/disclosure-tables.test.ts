// #729 PR-3 (RECORD 01 #6; 05 "the proof", its second check): core's class tables. The table-
// generated suite plants a distinct fake canary in every value-, bounded- and question-classed field
// of every core table, walks the generated object for each audience and asserts where each canary
// may appear. Every value is fake. Failures print field PATHS and booleans, never a canary.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { compileDisclosure, type DisclosureAudience, type DisclosureEntry } from './redaction.js';
import type { ClassTable, DisclosureClass, FactProducers } from './disclosure-walk.js';
import {
  GATE_INFO_TABLE,
  PENDING_GATE_TABLE,
  RUN_RECORD_TABLE,
  discloseGate,
  discloseRecord,
  discloseReply,
} from './disclosure-tables.js';
import type { PendingGate, RunRecord } from '../types/run-record.js';

/** A planted field: its path, its class, its environment canary and its declared canary. */
interface Planted {
  path: string;
  cls: 'value' | 'bounded' | 'question';
  env: string;
  declared: string;
}

const SKIP_KINDS = [
  'when_false',
  'trigger_rule_unsatisfiable',
  'handler_abort',
  'guard_abort',
  'gate_cancelled_by_abort',
  'gate_expired',
];

/** Generates an object for `table`, planting canaries; `kind` drives a per-discriminant table. */
function generate(table: ClassTable, path: string, planted: Planted[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(table)) {
    out[key] = generateRow(row, path === '' ? key : `${path}.${key}`, planted);
  }
  return out;
}

function generateRow(row: DisclosureClass, path: string, planted: Planted[]): unknown {
  if (row === 'fact' || row === 'frozen') return `fact-of-${path}`;
  if (row === 'value' || row === 'bounded' || row === 'question') {
    const n = planted.length;
    const env = `FAKECANARYENV${String(n).padStart(4, '0')}`;
    const declared = `FAKECANARYDEC${String(n).padStart(4, '0')}`;
    planted.push({ path, cls: row, env, declared });
    return `text ${env} and ${declared} end`;
  }
  // #729 PR-3 correction 2 (E-11''): a row chosen by its value. A planted text holds run values, so
  // the row must mask it as a diagnostic copy: it is planted as `bounded`, whatever the row says.
  if ('choose' in row) return generateRow('bounded', path, planted);
  if ('map' in row) {
    if (typeof row.map === 'function') {
      // The skip-detail map: one entry per kind.
      return Object.fromEntries(
        SKIP_KINDS.map((kind) => {
          const table = (row.map as (v: unknown) => ClassTable)({ kind });
          const entry = generate(table, `${path}.${kind}`, planted);
          entry['kind'] = kind;
          return [`step_${kind}`, entry];
        }),
      );
    }
    return { some_key: generate(row.map, `${path}.some_key`, planted) };
  }
  const table = typeof row.nested === 'function' ? row.nested({}) : row.nested;
  return [generate(table, path, planted)];
}

function setEntries(planted: Planted[]): DisclosureEntry[] {
  return planted.flatMap((p) => [
    { value: p.env, source: `env:E_${p.path}` as const },
    { value: p.declared, source: `declared:D_${p.path}` as const },
  ]);
}

function setFrom(planted: Planted[], audience: DisclosureAudience) {
  return compileDisclosure(setEntries(planted), {
    declared: 'resolved',
    audience,
    environment: 'swept',
  }).set;
}

/** For each planted field: which canaries the shown text still holds. */
function leaks(shown: unknown, planted: Planted[]) {
  const text = JSON.stringify(shown);
  return planted.map((p) => ({
    path: p.path,
    cls: p.cls,
    env: text.includes(p.env),
    declared: text.includes(p.declared),
  }));
}

describe('#729 PR-3 — the table-generated suite over core tables', () => {
  for (const [name, table] of [
    ['RUN_RECORD_TABLE', RUN_RECORD_TABLE],
    ['PENDING_GATE_TABLE', PENDING_GATE_TABLE],
    ['GATE_INFO_TABLE', GATE_INFO_TABLE],
  ] as const) {
    it(`${name}: on agent no canary shows, except an environment canary in question text (R2)`, () => {
      const planted: Planted[] = [];
      const record = generate(table as ClassTable, '', planted);
      const set = setFrom(planted, 'agent');
      const shown =
        name === 'RUN_RECORD_TABLE'
          ? discloseRecord(record as unknown as RunRecord, set, 'agent').record
          : discloseGate(record as unknown as PendingGate, set, 'agent');
      // Non-vacuity: a field of each class was planted.
      // (a) red when a table loses every row of a class; (b) prints the class list.
      expect(new Set(planted.map((p) => p.cls)).size).toBeGreaterThan(1);
      // (a) red when any value-, bounded- or question-classed row is shown raw (the walk skipped, a
      //     row reclassified as fact), or question text gets the environment tier; (b) prints each
      //     planted field's path, class and two booleans.
      expect(leaks(shown, planted)).toEqual(
        planted.map((p) => ({
          path: p.path,
          cls: p.cls,
          env: p.cls === 'question',
          declared: false,
        })),
      );
    });
  }

  it('the facts are shown as they are', () => {
    const planted: Planted[] = [];
    const record = generate(RUN_RECORD_TABLE, '', planted);
    // The fact's own text is a member, so walking it as a value would hide it.
    const set = compileDisclosure(
      [{ value: 'fact-of-id', source: 'env:F' }, ...setEntries(planted)],
      { declared: 'resolved', audience: 'agent', environment: 'swept' },
    ).set;
    const shown = discloseRecord(record as unknown as RunRecord, set, 'agent').record;
    // (a) red when a fact is walked as a value (a shape or marker would replace it); (b) prints a value.
    expect((shown as unknown as Record<string, unknown>)['id']).toBe('fact-of-id');
  });
});

describe('#729 PR-3 — the door functions', () => {
  it('discloseRecord returns the receipt beside the record, and does not change the record', () => {
    const planted: Planted[] = [];
    const record = generate(RUN_RECORD_TABLE, '', planted);
    const before = JSON.stringify(record);
    const { receipt } = discloseRecord(
      record as unknown as RunRecord,
      setFrom(planted, 'agent'),
      'agent',
    );
    // (a) red when the receipt counts nothing or the record is written into; (b) prints numbers and a boolean.
    // Correction 4 (I-9b): the three digests of content the law hid inside are shown as their
    // shapes, not counted as hides; the receipt names their paths (every planted value accounted).
    expect({ declared: receipt.hidden.declared, shaped: receipt.shaped }).toEqual({
      declared: planted.length - 3,
      shaped: [
        'evidence[0].evidence_hash',
        'evidence[0].trace_digest',
        'workflow_context_snapshots.some_key.content_hash',
      ],
    });
    expect(JSON.stringify(record) === before).toBe(true);
  });

  it('discloseGate: the question at the declared tier on every audience; choices are acts, never masked', () => {
    const gate: PendingGate = {
      gate_id: 'g1',
      step_name: 'approve',
      preview: { body: 'FAKE-ENV-VALUE-0001' },
      choices: ['FAKE-ENV-VALUE-0001', 'reject'],
      opened_at: '2026-10-17T00:00:00.000Z',
      resolved_message: 'Ship FAKE-ENV-VALUE-0001 and FAKE-DECLARED-0002?',
    };
    const set = compileDisclosure(
      [
        { value: 'FAKE-ENV-VALUE-0001', source: 'env:A' },
        { value: 'FAKE-DECLARED-0002', source: 'declared:B' },
      ],
      { declared: 'resolved', audience: 'broadcast', environment: 'swept' },
    ).set;
    const shown = discloseGate(gate, set, 'broadcast');
    // (a) red when choices are masked, the question gets every tier, or the preview is not shaped on
    //     broadcast; (b) prints the shown fields.
    expect(shown.choices).toEqual(['FAKE-ENV-VALUE-0001', 'reject']);
    expect(shown.resolved_message).toBe('Ship FAKE-ENV-VALUE-0001 and [REDACTED]?');
    expect(shown.preview).toEqual({ body: '‹string, 19 characters›' });
  });

  it('discloseReply adds the receipt as the top-level `disclosure` field', () => {
    const set = compileDisclosure([{ value: 'FAKE-ENV-VALUE-0001', source: 'env:A' }], {
      declared: 'unknown',
      cause: 'embedder_none',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const reply = discloseReply({ status: 'ok', data: 'FAKE-ENV-VALUE-0001' }, set, 'agent', {
      status: 'fact',
      data: 'value',
    });
    // (a) red when the receipt is missing or the walk skipped; (b) prints the reply.
    expect(reply).toEqual({
      status: 'ok',
      data: '[REDACTED]',
      disclosure: {
        declared: 'unknown',
        declared_cause: 'embedder_none',
        environment: 'swept',
        hidden: { declared: 0, environment: 1, pattern: 0 },
        unchecked: 0,
        unmaskable: 0,
        too_deep: 0,
      },
    });
  });

  it('a table is compile-forced: a missing key and an unknown key both fail to compile', () => {
    // (a) red (as a compile error in typecheck:tests) when either `@ts-expect-error` stops being
    //     needed — i.e. the tables stop being forced; (b) the compiler prints the line.
    // @ts-expect-error — a missing key
    const missing = { gate_id: 'fact' } satisfies Record<keyof PendingGate, DisclosureClass>;
    const extra = {
      ...PENDING_GATE_TABLE,
      // @ts-expect-error — an unknown key
      not_a_field: 'fact',
    } satisfies Record<keyof PendingGate, DisclosureClass>;
    expect([typeof missing, typeof extra]).toEqual(['object', 'object']);
  });
});

describe('#729 PR-3 correction 1 — F5: every string `fact` row names what produces it', () => {
  it('a registry missing a string `fact` row, or an `unknown`-typed one, does not compile', () => {
    type Shape = { id: string; note: string; count: number; extra: unknown };
    type Table = { id: 'fact'; note: 'value'; count: 'fact'; extra: 'fact' };
    // (a) red (as a compile error in typecheck:tests) when either `@ts-expect-error` stops being
    //     needed — the entries made optional, or an `unknown` field judged unable to hold text
    //     (fail-open); (b) the compiler prints the line; at run time, prints the complete entry's
    //     keys.
    // @ts-expect-error — the string `fact` row `id` names no producer
    const missingString = { extra: 'enum' } satisfies FactProducers<Table, Shape>;
    // @ts-expect-error — the `unknown`-typed `fact` row `extra` can hold text, so it names one too
    const missingUnknown = { id: 'id' } satisfies FactProducers<Table, Shape>;
    const complete = { id: 'id', extra: 'enum' } satisfies FactProducers<Table, Shape>;
    expect([typeof missingString, typeof missingUnknown, Object.keys(complete)]).toEqual([
      'object',
      'object',
      ['id', 'extra'],
    ]);
  });
});

describe('#729 PR-3 correction 4 (I-9) — a hash of value content is shown as the value is', () => {
  const hex = (c: string): string => c.repeat(64);
  const SHAPE = '‹string, 64 characters›';
  const record = {
    id: 'run-c4-0729',
    evidence: [
      {
        step_id: 'a',
        status: 'success',
        output_summary: { approved: true },
        evidence_hash: hex('a'),
        trace_digest: hex('b'),
        agent_profile_hash: hex('c'),
      },
    ],
    workflow_context_snapshots: {
      brief: {
        source_path: 'brief.md',
        content: 'FAKEcontent0729',
        content_hash: hex('d'),
        loaded_at: '2026-10-21T00:00:00.000Z',
      },
    },
    extension_identity: [
      {
        captured_at: '2026-10-21T00:00:00.000Z',
        modules: [{ specifier: './m.js', entry_hash: hex('e') }],
        tree: { tree_hash: hex('f') },
        manifest: { path: 'realm.yaml', content_hash: hex('1'), secrets_block_hash: hex('2') },
      },
    ],
  } as unknown as RunRecord;
  interface Shown {
    evidence: Array<Record<string, unknown>>;
    workflow_context_snapshots: Record<string, Record<string, unknown>>;
    extension_identity: Array<{
      modules: Array<Record<string, unknown>>;
      tree: Record<string, unknown>;
      manifest: Record<string, unknown>;
    }>;
  }
  const walked = (audience: DisclosureAudience, withhold = false): Shown =>
    discloseRecord(
      record,
      compileDisclosure([], { declared: 'resolved', audience, environment: 'swept' }).set,
      audience,
      withhold ? { withhold: 'manifest_changed' } : {},
    ).record as unknown as Shown;

  it('the output, trace and context digests: shapes on a broadcast and under withholding, whole at the tier', () => {
    const digests = (shown: Shown) => [
      shown.evidence[0]!['evidence_hash'],
      shown.evidence[0]!['trace_digest'],
      shown.workflow_context_snapshots['brief']!['content_hash'],
    ];
    // (a) red when a digest row is a fact (its hex shows on a broadcast and under withholding);
    //     (b) prints the three digests per case (shapes, or the fake hex).
    expect({
      broadcast: digests(walked('broadcast')),
      withheld: digests(walked('private', true)),
      private: digests(walked('private')),
      agent: digests(walked('agent')),
    }).toEqual({
      broadcast: [SHAPE, SHAPE, SHAPE],
      withheld: [SHAPE, SHAPE, SHAPE],
      private: [hex('a'), hex('b'), hex('d')],
      agent: [hex('a'), hex('b'), hex('d')],
    });
  });

  it("a file's digest stays a fact: the agent profile's and the extension identity's hashes whole on every audience", () => {
    const whole = (shown: Shown): boolean[] => {
      const ext = shown.extension_identity[0]!;
      return [
        shown.evidence[0]!['agent_profile_hash'] === hex('c'),
        ext.modules[0]!['entry_hash'] === hex('e'),
        ext.tree['tree_hash'] === hex('f'),
        ext.manifest['content_hash'] === hex('1'),
        ext.manifest['secrets_block_hash'] === hex('2'),
      ];
    };
    const all = [true, true, true, true, true];
    // (a) red when a file's digest is classed a value (it is shaped on a broadcast and under
    //     withholding); (b) prints booleans per case.
    expect([
      whole(walked('broadcast')),
      whole(walked('private', true)),
      whole(walked('private')),
      whole(walked('agent')),
    ]).toEqual([all, all, all, all]);
  });
});

describe('#729 PR-3 correction 4 (I-9b) — a digest of content the law hid anything inside is a shape on every tier', () => {
  const PIN = 'FK42';
  const SHAPE = '‹string, 64 characters›';
  const sha = (v: unknown): string =>
    createHash('sha256')
      .update(typeof v === 'string' ? v : JSON.stringify(v))
      .digest('hex');
  const withPin = { pin: PIN };
  const plain = { pin: 'open' };
  const recordOf = (output: unknown, extra: Record<string, unknown> = {}): RunRecord =>
    ({
      id: 'run-c4b-0729',
      evidence: [
        {
          step_id: 'a',
          status: 'success',
          output_summary: output,
          evidence_hash: sha(output),
          ...extra,
        },
      ],
    }) as unknown as RunRecord;
  const walk = (record: RunRecord, audience: DisclosureAudience) =>
    discloseRecord(
      record,
      compileDisclosure([{ value: PIN, source: 'declared:PIN' }], {
        declared: 'resolved',
        audience,
        environment: 'swept',
      }).set,
      audience,
    );
  const evidence = (r: ReturnType<typeof walk>) =>
    (r.record as unknown as { evidence: Array<Record<string, unknown>> }).evidence[0]!;

  for (const audience of ['agent', 'log', 'file'] as const) {
    it(`on ${audience}: the output's member hidden, its digest shown as its shape, the receipt naming its path`, () => {
      const r = walk(recordOf(withPin), audience);
      // (a) red when the digest does not follow its source (the hex beside `[REDACTED]`); (b)
      //     prints the output (a marker), the digest (a shape) and the paths.
      expect({
        output: evidence(r)['output_summary'],
        digest: evidence(r)['evidence_hash'],
        shaped: r.receipt.shaped,
      }).toEqual({
        output: { pin: '[REDACTED]' },
        digest: SHAPE,
        shaped: ['evidence[0].evidence_hash'],
      });
    });
  }

  it('the control: an output the law hid nothing inside keeps its digest whole on every tier', () => {
    const digests = (['agent', 'log', 'file', 'private'] as const).map(
      (a) => evidence(walk(recordOf(plain), a))['evidence_hash'] === sha(plain),
    );
    // (a) red when any content shapes its digest; (b) prints booleans.
    expect(digests).toEqual([true, true, true, true]);
  });

  it("a trace holding a hidden member shapes `trace_digest`; a context file's holding one shapes `content_hash`", () => {
    const trace = [{ note: `asked with ${PIN}` }];
    const content = `the pin is ${PIN}`;
    const withTrace = walk(recordOf(plain, { trace, trace_digest: sha(trace) }), 'agent');
    const withContext = walk(
      {
        ...recordOf(plain),
        workflow_context_snapshots: {
          brief: {
            source_path: 'brief.md',
            content,
            content_hash: sha(content),
            loaded_at: '2026-10-21T00:00:00.000Z',
          },
        },
      } as unknown as RunRecord,
      'agent',
    );
    // (a) red when either digest does not follow its source; (b) prints two shapes.
    expect([
      evidence(withTrace)['trace_digest'],
      (
        withContext.record as unknown as {
          workflow_context_snapshots: Record<string, Record<string, unknown>>;
        }
      ).workflow_context_snapshots['brief']!['content_hash'],
    ]).toEqual([SHAPE, SHAPE]);
  });

  it("DQ1: the guessed output's digest appears in no tier's rendering (the probe, as a cell)", () => {
    const guessed = sha({ pin: PIN });
    const audiences = ['private', 'agent', 'log', 'file', 'broadcast'] as const;
    // (a) red when any tier prints the digest of an output whose member it hid; (b) prints booleans.
    expect(
      audiences.map((a) => JSON.stringify(walk(recordOf(withPin), a).record).includes(guessed)),
    ).toEqual([false, false, false, false, false]);
  });
});
