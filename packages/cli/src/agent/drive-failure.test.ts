// drive-failure.test.ts — the fence and the classifier (issue #401).
//
// The fence's whole job is to never make its own failure the operator's problem: the original
// error line has already been printed, and nothing here may replace it, hide it, or crash on top
// of it. Most of these cells are about that discipline rather than about the happy path.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowError } from '@sensigo/realm';
import type { RunRecord, DriveFailureRecord } from '@sensigo/realm';
import {
  recordDriveFailure,
  classifyDriveError,
  buildEntry,
  findDriveCall,
  lostLine,
} from './drive-failure.js';
import { setAdditionalRedactionValues } from './providers/agent-utils.js';

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
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
    ...over,
  } as RunRecord;
}

function entry(over: Partial<DriveFailureRecord> = {}): DriveFailureRecord {
  return {
    at: '2026-01-01T00:01:00.000Z',
    step: 'classify',
    provider: 'anthropic',
    error_class: 'other',
    message: 'boom',
    elapsed_ms: 5,
    ...over,
  };
}

/** A store double whose `update` can be scripted to throw typed WorkflowErrors. */
function makeStore(run: RunRecord, updateBehaviour: Array<'ok' | string> = ['ok']) {
  let current = run;
  const calls = { get: 0, update: 0 };
  let i = 0;
  return {
    calls,
    get current() {
      return current;
    },
    store: {
      get: async (): Promise<RunRecord> => {
        calls.get++;
        return current;
      },
      update: async (record: RunRecord): Promise<RunRecord> => {
        calls.update++;
        const behaviour = updateBehaviour[i++] ?? 'ok';
        if (behaviour !== 'ok') {
          throw new WorkflowError(`scripted ${behaviour}`, {
            code: behaviour as never,
            category: 'STATE',
            agentAction: 'report_to_user',
            retryable: true,
          });
        }
        current = { ...record, version: record.version + 1 };
        return current;
      },
    },
  };
}

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    errors.push(String(m));
  });
});

describe('recordDriveFailure — the fence (issue #401)', () => {
  it('a snapshot mismatch is re-read and re-applied, producing exactly ONE entry', async () => {
    const h = makeStore(makeRun(), ['STATE_SNAPSHOT_MISMATCH', 'ok']);
    await recordDriveFailure(h.store, 'r1', entry());
    expect(h.current.drive_failures?.entries).toHaveLength(1);
    expect(h.current.drive_failures?.total).toBe(1);
    expect(errors).toEqual([]);
  });

  it('RUN_BUSY is retried too — the second member of the retry set', async () => {
    const h = makeStore(makeRun(), ['STATE_RUN_BUSY', 'ok']);
    await recordDriveFailure(h.store, 'r1', entry());
    expect(h.current.drive_failures?.entries).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('exhausting the retries prints ONE loud line naming what was lost, and does not throw', async () => {
    const h = makeStore(makeRun(), [
      'STATE_SNAPSHOT_MISMATCH',
      'STATE_SNAPSHOT_MISMATCH',
      'STATE_SNAPSHOT_MISMATCH',
    ]);
    await expect(
      recordDriveFailure(
        h.store,
        'r1',
        entry({ error_class: 'api_status', message: 'rate limit' }),
      ),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('drive-failure record LOST for run r1');
    expect(errors[0]).toContain('api_status');
    expect(errors[0]).toContain("step 'classify'");
    expect(errors[0]).toContain('rate limit');
  });

  it('a NON-retryable throw also degrades to the loud line — distinct from exhaustion', async () => {
    // The other-throw arm: a disk error is not contention, so there is nothing to re-apply.
    const store = {
      get: async (): Promise<RunRecord> => makeRun(),
      update: async (): Promise<RunRecord> => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    };
    await expect(recordDriveFailure(store, 'r1', entry())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('drive-failure record LOST');
  });

  it('a run that is already terminal is a SILENT skip — the seal is the visibility', async () => {
    const h = makeStore(makeRun({ terminal_state: true }));
    await recordDriveFailure(h.store, 'r1', entry());
    expect(h.calls.update).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a vanished run is a SILENT skip — disposal is the visibility', async () => {
    const store = {
      get: async (): Promise<RunRecord> => {
        throw new WorkflowError('gone', {
          code: 'STATE_RUN_NOT_FOUND',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      },
      update: async (): Promise<RunRecord> => makeRun(),
    };
    await expect(recordDriveFailure(store, 'r1', entry())).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('THE RING: seven failures keep the last five, and the counters do NOT roll with them', async () => {
    const h = makeStore(makeRun());
    for (let i = 1; i <= 7; i++) {
      await recordDriveFailure(
        h.store,
        'r1',
        entry({ at: `2026-01-01T00:0${String(i)}:00.000Z`, message: `fail ${String(i)}` }),
      );
    }
    const field = h.current.drive_failures;
    expect(field?.entries).toHaveLength(5);
    expect(field?.total).toBe(7);
    // The first failure's timestamp survives the ring rolling over it — a ring alone cannot say
    // when trouble started, which is the one fact an operator asks first.
    expect(field?.first_failed_at).toBe('2026-01-01T00:01:00.000Z');
    // Most-recent-LAST.
    expect(field?.entries[4]?.message).toBe('fail 7');
    expect(field?.entries[0]?.message).toBe('fail 3');
  });
});

describe('classifyDriveError — precedence (issue #401)', () => {
  it('an SDK timeout name classifies as connection_timeout', () => {
    expect(
      classifyDriveError(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }))
        .error_class,
    ).toBe('connection_timeout');
  });

  it('an SDK connection name classifies as connection_error', () => {
    expect(
      classifyDriveError(Object.assign(new Error('x'), { name: 'APIConnectionError' })).error_class,
    ).toBe('connection_error');
  });

  it('a status-carrying error classifies api_status AND carries the status VALUE forward', () => {
    // The status is this class's only discriminator, and its only producer in PR-1. Dropping it
    // from this arm leaves an operator with "api_status" and no idea whether it was a 429 or a 500.
    const built = buildEntry(
      Object.assign(new Error('rate limited'), { status: 429 }),
      's',
      'openai',
      Date.now(),
    );
    expect(built.error_class).toBe('api_status');
    expect(built.last_observed_status).toBe(429);
  });

  it('PRECEDENCE — a recognized NAME beats a status on the same error', () => {
    const err = Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError', status: 500 });
    expect(classifyDriveError(err).error_class).toBe('connection_timeout');
  });

  it('PAYLOAD-FIRST — a driveCall payload two cause-wraps deep wins, and its elapsed_ms survives', () => {
    // The wrapping is the realistic case: a provider's retry ladder wraps the original error, so
    // the payload that knows what happened is a cause or two down. Reading only the outermost
    // error would call every wrapped failure 'other'.
    const inner = Object.assign(new Error('no sdk'), {
      driveCall: { error_class: 'sdk_missing' as const, attempts_sdk: 0, elapsed_ms: 0 },
    });
    const middle = new Error('ladder failed', { cause: inner });
    const outer = new Error('step failed', { cause: middle });

    expect(findDriveCall(outer)).toBeDefined();
    const built = buildEntry(outer, 's', 'openai', Date.now() - 5000);
    expect(built.error_class).toBe('sdk_missing');
    // `??` not `||`: a genuine 0ms span must survive. An `||` regression falls through to the
    // catch-side elapsed and reports ~5000 here.
    expect(built.elapsed_ms).toBe(0);
  });

  it('a bare Error classifies as other', () => {
    expect(classifyDriveError(new Error('mystery')).error_class).toBe('other');
  });

  it('the message is CAPPED at 500 characters', () => {
    const built = buildEntry(new Error('x'.repeat(2000)), 's', 'p', Date.now());
    expect(built.message).toHaveLength(500);
  });

  it('the message is SANITIZED — a manifest secret never reaches the record', () => {
    // The cap alone is not enough: a recorded error is durable, and a token in it is durable too.
    setAdditionalRedactionValues(['sk-super-secret-value']);
    try {
      const built = buildEntry(
        new Error('auth failed for sk-super-secret-value'),
        's',
        'p',
        Date.now(),
      );
      expect(built.message).not.toContain('sk-super-secret-value');
      expect(built.message).toContain('[REDACTED]');
    } finally {
      setAdditionalRedactionValues([]);
    }
  });

  it('lostLine names the run, the class, the time, the step and the message', () => {
    const line = lostLine(
      'run-9',
      entry({ error_class: 'connection_error', message: 'socket hang up' }),
    );
    expect(line).toContain('run-9');
    expect(line).toContain('connection_error');
    expect(line).toContain("step 'classify'");
    expect(line).toContain('socket hang up');
  });
});
