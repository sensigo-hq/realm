// drive-failure-render.test.ts — how a drive failure READS on inspect (issue #401).
//
// The parity guards already prove every field reaches this surface. These cells are about the two
// ways the rendering was wrong regardless: a fabricated number, and a broken line.
import { describe, it, expect } from 'vitest';
import type { DriveFailureRecord, RunRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';

function runWith(entry: DriveFailureRecord, total = 1): RunRecord {
  return {
    id: 'run_test1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    drive_failures: { first_failed_at: entry.at, total, entries: [entry] },
  } as unknown as RunRecord;
}

const BASE: DriveFailureRecord = {
  at: '2026-01-01T00:04:00.000Z',
  step: 'classify',
  provider: 'anthropic',
  error_class: 'connection_error',
  message: 'socket hang up',
  elapsed_ms: 1200,
};

const render = (run: RunRecord): Promise<string> =>
  inspectRun(
    'run_test1',
    { get: async () => run, list: async () => [run] } as never,
    {
      get: async () => {
        throw new Error('not registered');
      },
      register: async () => {},
      list: async () => [],
    } as never,
  );

describe('#401 inspect — the clocks segment never fabricates a number', () => {
  it('a CEILING-ONLY entry renders the ceiling and says nothing about a declared value', async () => {
    // The falsity this closes: a `?? 0` printed "declared 0ms" for an entry that declared
    // nothing. Zero is a real number an operator would act on — it reads as "the timeout was set
    // to zero", which is a different bug report than the one they have.
    const out = await render(runWith({ ...BASE, derived_ceiling_ms: 1_860_000 }));
    expect(out).toContain('(ceiling 1860000ms)');
    expect(out).not.toContain('declared');
  });

  it('a DECLARED-ONLY entry renders the declared value and says nothing about a ceiling', async () => {
    const out = await render(runWith({ ...BASE, declared_per_attempt_ms: 600_000 }));
    expect(out).toContain('(declared 600000ms)');
    expect(out).not.toContain('ceiling');
  });

  it('an entry carrying BOTH renders both', async () => {
    const out = await render(
      runWith({ ...BASE, declared_per_attempt_ms: 600_000, derived_ceiling_ms: 1_860_000 }),
    );
    expect(out).toContain('(declared 600000ms)');
    expect(out).toContain('(ceiling 1860000ms)');
  });

  it('an entry carrying NEITHER renders no clock segment at all', async () => {
    const out = await render(runWith(BASE));
    expect(out).not.toContain('declared');
    expect(out).not.toContain('ceiling');
  });
});

describe('#401 inspect — one entry, one line', () => {
  it('a multi-line provider message renders on a SINGLE line', async () => {
    // `sanitizeError` preserves newlines, and provider errors routinely carry them. Rendered raw,
    // one entry sprawls over four lines and the block stops being scannable — the whole reason it
    // is one line per entry.
    const multiline = 'Connection error.\n  at Fetch (node:internal)\n  at process.run';
    const out = await render(runWith({ ...BASE, message: multiline }));

    const entryLine = out.split('\n').find((l) => l.includes('connection_error after 1200ms'));
    expect(entryLine).toBeDefined();
    expect(entryLine).toContain('Connection error. at Fetch (node:internal) at process.run');
  });

  it('the STORED entry keeps its newlines — only the render collapses them', async () => {
    // Display-only, deliberately: the record is evidence and must not be lossy because one
    // surface wants a single line.
    const multiline = 'line one\nline two';
    const run = runWith({ ...BASE, message: multiline });
    await render(run);
    expect(run.drive_failures?.entries[0]?.message).toBe(multiline);
  });
});

describe('#401 inspect — the total line appears only when the ring has rolled', () => {
  it('total > entries.length ⇒ the total line is printed', async () => {
    const out = await render(runWith(BASE, 9));
    expect(out).toContain('9 total since 2026-01-01T00:04:00.000Z');
  });

  it('total === entries.length ⇒ NO total line (it would restate the entries)', async () => {
    const out = await render(runWith(BASE, 1));
    expect(out).not.toContain('total since');
  });
});
