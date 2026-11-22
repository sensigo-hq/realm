// startup-failure-592c.test.ts — Q1 (#592) unit c, check 3 (prompt q1-c-startup-death-mark.md): the
// worker's startup mark, at its helper. `recordStartupFailure` writes one `startup_failure` entry
// through `recordDriveFailure` and returns the refusal's closing sentence for what the write did —
// one sentence per outcome. The built-CLI cells (startup-failure-592c.test.ts under commands/) reach
// `written` and `not_found`; the ended run and the store that refuses sit here, with a store double.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowError, type RunRecord, type Snapshot } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { recordStartupFailure, startupOutcomeSentence } from './startup-failure.js';
import { snap } from '../test-support/snapshot-double.js';

const WRITTEN = (id: string) =>
  `Run ${id} keeps this failure under Drive failures; realm run list --stuck lists it until the run next records a step or a question, or ends.`;

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

async function openRun(store: InMemoryStore): Promise<RunRecord> {
  return (await store.create({ workflowId: 'q1c', workflowVersion: 1, params: {} })).record;
}

describe('Q1 (#592) unit c — check 3: the four outcomes, one closing sentence each', () => {
  it('the four sentences, word for word', () => {
    // (a) red when a sentence's words change; (b) prints all four.
    expect(
      (['written', 'run_ended', 'not_found', 'not_written'] as const).map((o) =>
        startupOutcomeSentence('r-1', o),
      ),
    ).toEqual([
      WRITTEN('r-1'),
      'Run r-1 had already ended; nothing was recorded.',
      'Run r-1 is not in the store; nothing was recorded.',
      'Run r-1 could not be updated; the failure was not recorded.',
    ]);
  });

  it('an open run: written — one entry, no step, the asked provider, startup_failure, the message, a measured time, the model text every CLI entry carries', async () => {
    const store = new InMemoryStore();
    const run = await openRun(store);
    const sentence = await recordStartupFailure(store, run.id, {
      provider: 'anthropic',
      message: '--model is required: realm has no default model.',
      recordModelText: true,
    });
    const after = (await store.get(run.id)).record;
    const [entry] = after.drive_failures?.entries ?? [];
    // (a) red when the helper writes nothing, a second entry, or another shape (a step, another
    //     class, no model_text — which inspect --verbose would call "0.50.0 and earlier did not keep
    //     it" — or a time of 0); (b) prints the sentence and the entry.
    expect({
      sentence,
      total: after.drive_failures?.total,
      entry: { ...entry, at: typeof entry?.at, elapsed_ms: (entry?.elapsed_ms ?? 0) > 0 },
    }).toEqual({
      sentence: WRITTEN(run.id),
      total: 1,
      entry: {
        at: 'string',
        step: '',
        provider: 'anthropic',
        error_class: 'startup_failure',
        message: '--model is required: realm has no default model.',
        elapsed_ms: true,
        evidence_count: 0,
        model_text: { recorded: true, messages: [], tools: [], requests: [] },
      },
    });
    expect(errors).toEqual([]);
  });

  it('no --provider: the entry names unknown; --no-record-model-text: the model text is switched off; a long message is capped at 500', async () => {
    const store = new InMemoryStore();
    const run = await openRun(store);
    await recordStartupFailure(store, run.id, {
      provider: undefined,
      message: 'x'.repeat(600),
      recordModelText: false,
    });
    const [entry] = (await store.get(run.id)).record.drive_failures?.entries ?? [];
    // (a) red when an absent provider is not `unknown`, the switch is ignored, or the cap is not
    //     applied; (b) prints the three values.
    expect([entry?.provider, entry?.model_text, entry?.message.length]).toEqual([
      'unknown',
      { recorded: false, why: 'switched_off' },
      500,
    ]);
  });

  it('an ended run: run_ended — nothing written', async () => {
    const store = new InMemoryStore();
    const run = await openRun(store);
    const ended = { ...run, terminal_state: true } as RunRecord;
    const update = vi.fn(async (): Promise<Snapshot> => {
      throw new Error('update must not be called');
    });
    const double = {
      get: async (): Promise<Snapshot> => snap(ended),
      update,
      clock: store.clock,
    };
    const sentence = await recordStartupFailure(double, run.id, {
      provider: 'anthropic',
      message: 'm',
      recordModelText: true,
    });
    // (a) red when an ended run is written to, or the sentence is another outcome's; (b) prints the
    //     sentence and the update count.
    expect({ sentence, updates: update.mock.calls.length, errors }).toEqual({
      sentence: `Run ${run.id} had already ended; nothing was recorded.`,
      updates: 0,
      errors: [],
    });
  });

  it('a missing run: not_found', async () => {
    const store = new InMemoryStore();
    const sentence = await recordStartupFailure(store, 'no-such-run', {
      provider: undefined,
      message: 'm',
      recordModelText: true,
    });
    // (a) red when a missing run is reported as another outcome; (b) prints the sentence.
    expect({ sentence, errors }).toEqual({
      sentence: 'Run no-such-run is not in the store; nothing was recorded.',
      errors: [],
    });
  });

  it("a store whose update refuses: not_written, with the fence's lost line beside it", async () => {
    const store = new InMemoryStore();
    const run = await openRun(store);
    const double = {
      get: (id: string) => store.get(id),
      update: async (): Promise<Snapshot> => {
        throw new WorkflowError('the store refused the write', {
          code: 'STATE_STORE_WRITES_FENCED',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        });
      },
      clock: store.clock,
    };
    const sentence = await recordStartupFailure(double, run.id, {
      provider: 'anthropic',
      message: 'no key',
      recordModelText: true,
    });
    // (a) red when a refused write is reported as written (or found/ended), or the lost line is not
    //     printed; (b) prints the sentence and the lines.
    expect({
      sentence,
      lost: errors.map((l) => l.startsWith(`⚠ drive-failure record LOST for run ${run.id}`)),
    }).toEqual({
      sentence: `Run ${run.id} could not be updated; the failure was not recorded.`,
      lost: [true],
    });
  });
});
