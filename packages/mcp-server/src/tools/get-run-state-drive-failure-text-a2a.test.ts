// Gap 1, unit A2a, check 4 — get_run_state shows each drive failure without its `model_text` (the
// model calls' texts), every other key as stored, in its order. Asserted directly here, because the
// parity test's waiver for `model_text` skips that field's probe (CR-AUA2-14).
//
// The cell names the break that turns it red (prompts/gap1-a2a-store-side.md, check 4) and prints
// each shown entry.
import { describe, it, expect } from 'vitest';
import type {
  DriveFailureModelText,
  DriveFailureRecord,
  RunRecord,
  RunStore,
} from '@sensigo/realm';
import { declared } from '../test-support/declared.js';
import { handleGetRunState } from './get-run-state.js';
import {
  snap,
  doubleClock,
  noSettle,
  neverPurges,
  notScanned,
} from '../test-support/snapshot-double.js';

const TEXT: DriveFailureModelText = {
  recorded: true,
  messages: [{ role: 'user', text: 'the text of a failed call (a fake value)' }],
  tools: [],
  requests: [{ request_id: null, sent: [0], reply: null }],
  dropped_messages: 1,
};

const failure = (n: number, modelText?: DriveFailureModelText): DriveFailureRecord => ({
  at: `2026-01-01T00:0${n}:00.000Z`,
  step: 'classify',
  provider: 'anthropic',
  error_class: 'connection_error',
  message: `connection dropped ${n}`,
  elapsed_ms: 1000 + n,
  ...(modelText !== undefined ? { model_text: modelText } : {}),
});

const ENTRIES = [
  failure(1, TEXT),
  failure(2, { recorded: false, why: 'provider_did_not_report' }),
  failure(3),
];

function storeOf(run: RunRecord): RunStore {
  return declared({
    clock: doubleClock,
    settleStep: noSettle,
    persistsClaims: true,
    get: async () => snap(run),
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    scan: notScanned,
    ...neverPurges,
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore);
}

const run = {
  id: 'r-a2a',
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
  drive_failures: { first_failed_at: ENTRIES[0]!.at, total: 7, entries: ENTRIES },
} as unknown as RunRecord;

describe('gap 1, unit A2a — get_run_state never shows a drive failure’s model_text', () => {
  it('check 4: each drive failure is shown without model_text, every other key as stored, in its order', async () => {
    const summary = await handleGetRunState({ run_id: 'r-a2a' }, { runStore: storeOf(run) });
    const withoutText = (entry: DriveFailureRecord): Record<string, unknown> => {
      const { model_text: _text, ...rest } = entry;
      void _text;
      return rest;
    };
    // (1) red when boundedDriveFailures passes model_text through; (2) prints each shown entry.
    expect({
      keys: summary.drive_failures?.entries.map((entry) => Object.keys(entry)),
      entries: summary.drive_failures?.entries,
      total: summary.drive_failures?.total,
    }).toEqual({
      keys: ENTRIES.map((entry) => Object.keys(withoutText(entry))),
      entries: ENTRIES.map(withoutText),
      total: 7,
    });
  });
});
