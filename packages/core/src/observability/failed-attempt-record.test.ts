// Tests for the pure failed-attempt record builder + serializer (P2 observability).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildFailedAttemptRecord,
  moreOf,
  serializeFailedAttemptLine,
} from './failed-attempt-record.js';
import type { BuildFailedAttemptInput, FailedAttemptRecord } from './failed-attempt-record.js';

function baseInput(over: Partial<BuildFailedAttemptInput> = {}): BuildFailedAttemptInput {
  return {
    run_id: 'run-1',
    workflow_id: 'wf-1',
    step_id: 'classify',
    ts: '2026-06-27T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [],
    params: {},
    trace_entry_count: 0,
    ...over,
  };
}

describe('buildFailedAttemptRecord', () => {
  it('copies the scalar metadata fields verbatim', () => {
    const rec = buildFailedAttemptRecord(
      baseInput({
        run_id: 'r',
        workflow_id: 'w',
        step_id: 's',
        ts: 'T',
        error_code: 'VALIDATION_INPUT_SCHEMA',
        trace_entry_count: 3,
      }),
    );
    expect(rec).toMatchObject({
      run_id: 'r',
      workflow_id: 'w',
      step_id: 's',
      ts: 'T',
      error_code: 'VALIDATION_INPUT_SCHEMA',
      trace_entry_count: 3,
    });
  });

  it('whitelists Ajv fields and DROPS the params/data value echoes (leak vector)', () => {
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [
          {
            instancePath: '/status',
            schemaPath: '#/properties/status/enum',
            keyword: 'enum',
            message: 'must be equal to one of the allowed values',
            params: { allowedValues: ['open', 'closed'] },
            data: 'SECRET_CUSTOMER_VALUE',
          },
        ],
      }),
    );
    expect(rec.validation_error_summary).toEqual([
      {
        instancePath: '/status',
        schemaPath: '#/properties/status/enum',
        keyword: 'enum',
        message: 'must be equal to one of the allowed values',
      },
    ]);
    // The offending value echo must not appear anywhere in the serialized record.
    expect(JSON.stringify(rec)).not.toContain('SECRET_CUSTOMER_VALUE');
    expect(JSON.stringify(rec)).not.toContain('allowedValues');
  });

  it('truncates instancePath/schemaPath/message to 200 chars', () => {
    const long = 'x'.repeat(500);
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [{ instancePath: long, schemaPath: long, keyword: 'type', message: long }],
      }),
    );
    const e = rec.validation_error_summary[0]!;
    expect(e.instancePath).toHaveLength(200);
    expect(e.schemaPath).toHaveLength(200);
    expect(e.message).toHaveLength(200);
  });

  it('caps validation_error_summary at the first 10 entries', () => {
    const errs = Array.from({ length: 25 }, (_, i) => ({
      instancePath: `/f${i}`,
      schemaPath: '#/x',
      keyword: 'type',
      message: 'bad',
    }));
    const rec = buildFailedAttemptRecord(baseInput({ ajv_errors: errs }));
    expect(rec.validation_error_summary).toHaveLength(10);
    expect(rec.validation_error_summary[0]!.instancePath).toBe('/f0');
  });

  it('submitted_keys are truncated to 100 chars and capped at 50; submitted_key_count is the full count', () => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < 120; i++) params[`k${i}`] = i;
    const longKey = 'L'.repeat(300);
    params[longKey] = 1;
    const rec = buildFailedAttemptRecord(baseInput({ params }));
    expect(rec.submitted_key_count).toBe(121); // full count
    expect(rec.submitted_keys).toHaveLength(50); // capped
    expect(rec.submitted_keys.every((k) => k.length <= 100)).toBe(true);
  });

  it('submitted_bytes equals the UTF-8 byte length of JSON.stringify(params)', () => {
    const params = { a: 'hello', b: 2 };
    const rec = buildFailedAttemptRecord(baseInput({ params }));
    expect(rec.submitted_bytes).toBe(Buffer.byteLength(JSON.stringify(params), 'utf8'));
  });

  it('never includes raw submitted VALUES — only key names', () => {
    const rec = buildFailedAttemptRecord(
      baseInput({ params: { ticket_body: 'PII: jane@example.com ordered 3 widgets' } }),
    );
    const serialized = JSON.stringify(rec);
    expect(serialized).toContain('ticket_body'); // key name is allowed
    expect(serialized).not.toContain('jane@example.com'); // value is not
    expect(rec.submitted_keys).toEqual(['ticket_body']);
  });

  // issue #217: keyword-conditional key-name-only fields feeding the CLI schema-repair prompt.
  it('populates additional_property for an additionalProperties error, missing_property for a required error, and neither for other keywords', () => {
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [
          {
            instancePath: '',
            schemaPath: '#/additionalProperties',
            keyword: 'additionalProperties',
            message: 'must NOT have additional properties',
            params: { additionalProperty: 'extra_field' },
          },
          {
            instancePath: '',
            schemaPath: '#/required',
            keyword: 'required',
            message: "must have required property 'status'",
            params: { missingProperty: 'status' },
          },
          {
            instancePath: '/status',
            schemaPath: '#/properties/status/enum',
            keyword: 'enum',
            message: 'must be equal to one of the allowed values',
            params: { allowedValues: ['open', 'closed'] },
          },
        ],
      }),
    );
    expect(rec.validation_error_summary[0]).toMatchObject({
      keyword: 'additionalProperties',
      additional_property: 'extra_field',
    });
    expect(rec.validation_error_summary[0]!.missing_property).toBeUndefined();
    expect(rec.validation_error_summary[1]).toMatchObject({
      keyword: 'required',
      missing_property: 'status',
    });
    expect(rec.validation_error_summary[1]!.additional_property).toBeUndefined();
    // enum entry gets neither new field — no key present at all (exactOptionalPropertyTypes).
    expect('additional_property' in rec.validation_error_summary[2]!).toBe(false);
    expect('missing_property' in rec.validation_error_summary[2]!).toBe(false);
  });

  it('truncates additional_property/missing_property at MAX_FIELD_CHARS (200)', () => {
    const longKey = 'k'.repeat(500);
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [
          {
            instancePath: '',
            schemaPath: '#/additionalProperties',
            keyword: 'additionalProperties',
            message: 'must NOT have additional properties',
            params: { additionalProperty: longKey },
          },
          {
            instancePath: '',
            schemaPath: '#/required',
            keyword: 'required',
            message: 'must have required property',
            params: { missingProperty: longKey },
          },
        ],
      }),
    );
    expect(rec.validation_error_summary[0]!.additional_property).toHaveLength(200);
    expect(rec.validation_error_summary[1]!.missing_property).toHaveLength(200);
  });

  it('is defensive: non-array ajv_errors yields an empty summary, no throw', () => {
    expect(() =>
      buildFailedAttemptRecord(baseInput({ ajv_errors: 'not-an-array' as unknown as unknown[] })),
    ).not.toThrow();
    const rec = buildFailedAttemptRecord(
      baseInput({ ajv_errors: 'not-an-array' as unknown as unknown[] }),
    );
    expect(rec.validation_error_summary).toEqual([]);
  });

  it('is defensive: malformed entries (non-objects, missing fields) are skipped/coerced without throwing', () => {
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [
          null,
          42,
          'string-entry',
          { keyword: 'required' }, // missing instancePath/schemaPath/message
          { instancePath: 99, message: { nested: 'obj' } }, // non-string fields → ''
        ],
      }),
    );
    // null/42/'string-entry' skipped; the two objects kept.
    expect(rec.validation_error_summary).toHaveLength(2);
    expect(rec.validation_error_summary[0]).toEqual({
      instancePath: '',
      schemaPath: '',
      keyword: 'required',
      message: '',
    });
    // Non-string instancePath/message coerced to '' (no object leak via String()).
    expect(rec.validation_error_summary[1]).toEqual({
      instancePath: '',
      schemaPath: '',
      keyword: '',
      message: '',
    });
  });

  it('does not throw on unstringifiable params (circular) — submitted_bytes falls back to 0', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const rec = buildFailedAttemptRecord(baseInput({ params: circular }));
    expect(rec.submitted_bytes).toBe(0);
    expect(rec.submitted_key_count).toBe(1);
  });
});

describe('serializeFailedAttemptLine', () => {
  it('a small record returns truncated:false and is unchanged', () => {
    const rec = buildFailedAttemptRecord(baseInput({ params: { a: 1 } }));
    const { line, truncated } = serializeFailedAttemptLine({
      event: 'agent_step_attempt_failed',
      ...rec,
    });
    expect(truncated).toBe(false);
    expect(JSON.parse(line)).toEqual({ event: 'agent_step_attempt_failed', ...rec });
  });

  it('preserves wrapper keys (event) on a small record', () => {
    const rec = buildFailedAttemptRecord(baseInput());
    const { line } = serializeFailedAttemptLine({
      event: 'agent_step_attempt_failed',
      dropped_attempts: 7,
      ...rec,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['event']).toBe('agent_step_attempt_failed');
    expect(parsed['dropped_attempts']).toBe(7);
  });

  it('an oversized record is reduced to <= maxBytes with truncated:true (drops summary, then keys)', () => {
    const longMsg = 'm'.repeat(180);
    const summary = Array.from({ length: 100 }, (_, i) => ({
      instancePath: `/field${i}`,
      schemaPath: '#/properties/x',
      keyword: 'type',
      message: longMsg,
    }));
    const submitted_keys = Array.from({ length: 500 }, (_, i) => `key_number_${i}`);
    const obj = {
      event: 'agent_step_attempt_failed',
      run_id: 'r',
      workflow_id: 'w',
      step_id: 's',
      ts: 'T',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      validation_error_summary: summary,
      submitted_key_count: 500,
      submitted_keys,
      submitted_bytes: 1234,
      trace_entry_count: 0,
    };
    const { line, truncated } = serializeFailedAttemptLine(obj);
    expect(truncated).toBe(true);
    expect(line.length).toBeLessThanOrEqual(3072);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(3072);
  });

  it('respects a custom maxBytes and still guarantees the bound (hard-substring fallback)', () => {
    // A single field too large to fit even after dropping summary + keys → hard substring.
    const obj = {
      event: 'agent_step_attempt_failed',
      run_id: 'r'.repeat(5000),
      workflow_id: 'w',
      step_id: 's',
      ts: 'T',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      validation_error_summary: [],
      submitted_key_count: 0,
      submitted_keys: [],
      submitted_bytes: 0,
      trace_entry_count: 0,
    };
    const { line, truncated } = serializeFailedAttemptLine(obj, 256);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(256);
  });
});

// issue #759 (Part E): the record says how many problems there were — `error_count`, the total
// before the cap, as the refusal carried it — and a reader computes "more" from the record AS READ
// (`error_count − entries`); a record written before #759 renders a floor, never an invented count.
// A failure prints counts only.
describe('issue #759 — the record carries the total; "more" as read', () => {
  /** Ten whitelisted-shape rows (the refusal's capped list) with 200-character messages. */
  const tenRows = Array.from({ length: 10 }, (_, i) => ({
    instancePath: `/f${i}`,
    schemaPath: '#/required',
    keyword: 'required',
    message: 'm'.repeat(200),
    params: { missingProperty: `f${i}` },
  }));

  it('`error_count` is written from the input, never recounted from the rows (red: recount → 10)', () => {
    const rec = buildFailedAttemptRecord(baseInput({ ajv_errors: tenRows, error_count: 13 }));
    expect({ entries: rec.validation_error_summary.length, total: rec.error_count }).toEqual({
      entries: 10,
      total: 13,
    });
  });

  it('`error_count` is absent when the caller has none', () => {
    const rec = buildFailedAttemptRecord(baseInput({ ajv_errors: tenRows }));
    expect('error_count' in rec).toBe(false);
  });

  it('the 3,072-byte trim pops entries from the end and keeps the total: 13 problems, 3 entries left → `more` 10 AS READ (reds: the trim drops the count; `− 10`)', () => {
    // sixteen 100-character key names leave room for exactly three entries (measured)
    const params = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`.padEnd(100, 'x'), 1]),
    );
    const rec = buildFailedAttemptRecord(
      baseInput({ ajv_errors: tenRows, error_count: 13, params }),
    );
    const serialized = serializeFailedAttemptLine({ ...rec });
    // as the MCP sidecar persists a reduced line
    const read = {
      ...(JSON.parse(serialized.line) as FailedAttemptRecord),
      ...(serialized.truncated ? { truncated: true as const } : {}),
    };
    expect({
      truncated: serialized.truncated,
      entries: read.validation_error_summary.length,
      total: read.error_count,
      more: moreOf(read),
    }).toEqual({ truncated: true, entries: 3, total: 13, more: 10 });
  });

  // pre-#759c1 title: 'a record written before #759 (no count): exact only when it holds fewer than
  // ten entries and was not trimmed, else a floor (`undefined`) — never `and 0 more` (red: 0 for
  // every old record)'
  it('a record that holds entries but no count (written by 0.47.0 or earlier, whose validator stopped at the first problem) is a floor (`undefined`) whatever it holds — never `and 0 more` (#759 correction 1, C1; red: the exact branch restored)', () => {
    const entries = (n: number) =>
      buildFailedAttemptRecord(baseInput({ ajv_errors: tenRows.slice(0, n) }))
        .validation_error_summary;
    // a trimmed record as the sidecar persists it: `truncated` no longer changes the answer
    const trimmed: Pick<FailedAttemptRecord, 'validation_error_summary' | 'truncated'> = {
      validation_error_summary: entries(3),
      truncated: true,
    };
    expect({
      oneEntry: moreOf({ validation_error_summary: entries(1) }),
      threeEntries: moreOf({ validation_error_summary: entries(3) }),
      tenEntries: moreOf({ validation_error_summary: entries(10) }),
      threeTrimmed: moreOf(trimmed),
      counted: moreOf({ validation_error_summary: entries(3), error_count: 13 }),
    }).toEqual({
      oneEntry: undefined,
      threeEntries: undefined,
      tenEntries: undefined,
      threeTrimmed: undefined,
      counted: 10,
    });
  });

  it("the record keeps the one whitelist without the schema's allowed values (#217/#224's choice)", () => {
    const rec = buildFailedAttemptRecord(
      baseInput({
        ajv_errors: [
          {
            instancePath: '/c',
            schemaPath: '#/properties/c/enum',
            keyword: 'enum',
            message: 'must be equal to one of the allowed values',
            params: { allowedValues: ['alpha', 'beta'] },
          },
        ],
      }),
    );
    expect(Object.keys(rec.validation_error_summary[0] ?? {}).sort()).toEqual([
      'instancePath',
      'keyword',
      'message',
      'schemaPath',
    ]);
  });

  it('the cap is the imported const, never a local number (red: a local `10` beside it)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./failed-attempt-record.ts', import.meta.url)),
      'utf8',
    );
    expect({
      imports:
        /import \{[^}]*VALIDATION_PROBLEMS_SHOWN[^}]*\} from '\.\.\/validation\/validation-problems\.js'/.test(
          src,
        ),
      localCap: /const MAX_SUMMARY_ENTRIES|>= 10\b/.test(src),
    }).toEqual({ imports: true, localCap: false });
  });
});
