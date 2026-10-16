// Tests for `realm run attempts <run-id>`. The command builds a FailedAttemptStore from the default
// $HOME/.realm/runs (JsonFileStore default, computed ONCE at module-load), so $HOME is set in
// beforeAll — before the first `@sensigo/realm` import — and shared across tests; each test uses a
// distinct run id for isolation. No static core import here; load it lazily.
// issue #285 (2026-08-13): fixed at the root — the default dir now resolves at CONSTRUCTION time,
// not module load (drain.ts's header has the full account). This file's lazy-import idiom stays;
// historicized here only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptsCommand } from './attempts.js';

let home: string;
let runsDir: string;
let originalHome: string | undefined;
let counter = 0;

describe('realm run attempts (CLI command)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'attempts-cli-'));
    runsDir = join(home, '.realm', 'runs');
    await mkdir(runsDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home; // set before the first '@sensigo/realm' import below
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function logged(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  function nextRunId(): string {
    counter += 1;
    return `1111111${counter}-2222-4333-8444-555555555555`.slice(0, 36);
  }

  async function seedAttempt(runId: string): Promise<void> {
    const { FailedAttemptStore, buildFailedAttemptRecord, serializeFailedAttemptLine } =
      await import('@sensigo/realm');
    const rec = buildFailedAttemptRecord({
      run_id: runId,
      workflow_id: 'wf',
      step_id: 'classify',
      ts: '2026-06-27T00:00:00.000Z',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      ajv_errors: [
        {
          instancePath: '/category',
          schemaPath: '#/required',
          keyword: 'required',
          message: 'must have required property category',
        },
      ],
      params: { ticket_body: 'x' },
      trace_entry_count: 0,
    });
    const store = new FailedAttemptStore(runsDir);
    await store.append(runId, serializeFailedAttemptLine({ ...rec }).line);
  }

  it('prints a table of recorded attempts', async () => {
    const runId = nextRunId();
    await seedAttempt(runId);
    await attemptsCommand.parseAsync([runId], { from: 'user' });
    const out = logged();
    expect(out).toContain('classify');
    expect(out).toContain('VALIDATION_OUTPUT_SCHEMA');
    expect(out).toContain('required');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--json prints the raw records', async () => {
    const runId = nextRunId();
    await seedAttempt(runId);
    await attemptsCommand.parseAsync([runId, '--json'], { from: 'user' });
    const parsed = JSON.parse(logged()) as { records: unknown[]; capped: boolean };
    expect(Array.isArray(parsed.records)).toBe(true);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.capped).toBe(false);
  });

  it('prints a friendly message when no attempts are recorded', async () => {
    await attemptsCommand.parseAsync([nextRunId()], { from: 'user' });
    expect(logged()).toContain('No failed attempts recorded');
  });

  it('shows the capped note when the sidecar reached its ceiling', async () => {
    const runId = nextRunId();
    const { FAILED_ATTEMPT_SIDECAR_MAX_BYTES } = await import('@sensigo/realm');
    await seedAttempt(runId); // one valid record first
    await appendFile(
      join(runsDir, `${runId}.attempts.jsonl`),
      'z'.repeat(FAILED_ATTEMPT_SIDECAR_MAX_BYTES) + '\n',
      'utf8',
    );
    await attemptsCommand.parseAsync([runId], { from: 'user' });
    expect(logged().toLowerCase()).toContain('ceiling');
  });
});

// issue #759 (Part F): the table prints EVERY entry a record holds (core's LINES) and `and N more`
// as read (`error_count − entries`), with the count on the row; a record written before #759 shows a
// FLOOR (`≥N problems`), never an invented remainder. A failure prints the table: key names, rules.
describe('issue #759 — realm run attempts prints every problem', () => {
  let home759: string;
  let runs759: string;
  let originalHome759: string | undefined;
  let logSpy759: ReturnType<typeof vi.spyOn>;
  let n759 = 0;

  beforeAll(async () => {
    home759 = await mkdtemp(join(tmpdir(), 'attempts-759-'));
    runs759 = join(home759, '.realm', 'runs');
    await mkdir(runs759, { recursive: true });
  });
  afterAll(async () => {
    await rm(home759, { recursive: true, force: true });
  });
  beforeEach(() => {
    originalHome759 = process.env['HOME'];
    process.env['HOME'] = home759;
    logSpy759 = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy759.mockRestore();
    if (originalHome759 === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome759;
  });

  const out = (): string => logSpy759.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const runId = (): string => {
    n759 += 1;
    return `75900000-0000-4000-8000-${String(n759).padStart(12, '0')}`;
  };
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      instancePath: '',
      schemaPath: '#/required',
      keyword: 'required',
      message: `must have required property 'f${String(i + 1).padStart(2, '0')}'`,
      params: { missingProperty: `f${String(i + 1).padStart(2, '0')}` },
    }));

  async function seed(id: string, n: number, errorCount?: number): Promise<void> {
    const { FailedAttemptStore, buildFailedAttemptRecord, serializeFailedAttemptLine } =
      await import('@sensigo/realm');
    const rec = buildFailedAttemptRecord({
      run_id: id,
      workflow_id: 'wf',
      step_id: 'extract',
      ts: '2026-10-16T00:00:00.000Z',
      error_code: 'VALIDATION_OUTPUT_SCHEMA',
      ajv_errors: rows(n),
      ...(errorCount !== undefined ? { error_count: errorCount } : {}),
      params: {},
      trace_entry_count: 0,
    });
    await new FailedAttemptStore(runs759).append(id, serializeFailedAttemptLine({ ...rec }).line);
  }

  it('13 problems → `13 problems` on the row, ten lines, then `and 3 more` (reds: `(+N more)`; the builder dropping the count)', async () => {
    const id = runId();
    await seed(id, 10, 13);
    await attemptsCommand.parseAsync([id], { from: 'user' });
    const lines = out().split('\n');
    expect({
      row: lines.some((l) => l.includes('extract') && l.endsWith('13 problems')),
      problemLines: lines.filter((l) => l.startsWith('    - (root): ')).length,
      tail: lines.filter((l) => l.trim().startsWith('and ')).map((l) => l.trim()),
      oldForm: out().includes('more)'),
    }).toEqual({ row: true, problemLines: 10, tail: ['and 3 more'], oldForm: false });
  });

  it('`--json` carries `error_count` on the record', async () => {
    const id = runId();
    await seed(id, 10, 13);
    await attemptsCommand.parseAsync([id, '--json'], { from: 'user' });
    const parsed = JSON.parse(out()) as { records: Array<{ error_count?: number }> };
    expect(parsed.records.map((r) => r.error_count)).toEqual([13]);
  });

  // pre-#759c1 title: 'a record written before #759 (no count): ten entries → the floor `≥10
  // problems` and no remainder; three entries → exact (red: `and 0 more`)'
  it('a record written by 0.47.0 or earlier (entries, no count) is a floor — one entry `≥1 problem`, three `≥3 problems`, ten `≥10 problems`, never a remainder (#759 correction 1, C1; reds: the exact branch restored → `1 problem`; the plural fixed → `≥1 problems`)', async () => {
    const rows: Record<number, string> = {};
    for (const n of [1, 3, 10]) {
      const id = runId();
      await seed(id, n);
      logSpy759.mockClear();
      await attemptsCommand.parseAsync([id], { from: 'user' });
      const text = out();
      rows[n] = `${
        text
          .split('\n')
          .find((l) => l.includes('extract'))
          ?.split('key(s)  ')[1]
      }${text.includes('and ') ? ' +and' : ''}`;
    }
    // (b) prints each row's label (a count, never a value) and whether a remainder followed.
    expect(rows).toEqual({ 1: '≥1 problem', 3: '≥3 problems', 10: '≥10 problems' });
  });
});
