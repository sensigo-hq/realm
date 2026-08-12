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
    return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
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
