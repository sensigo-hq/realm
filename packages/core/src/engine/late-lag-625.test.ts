// late-lag-625.test.ts — issue #625 PR-2a, the last prompt's F1 (framework blocker: shipped strength
// A.3 #5, "the expiry receipt names the enactor and the lag"): every call that carries out an expired
// question's `on_expiry` says how long before it the question's time was up, through core's one
// duration formatter, and every late answer's reply carries the fact typed (`error_details.expired_at`
// and `overdue_ms`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../index.js';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { writeTestClockFile } from '../store/test-clock-file.js';

/** #715 (b) (01 §C.4): the store's clock decides what is due — a JSON store on a test location: its
 *  runs folder sits beside the location's clock file (first set to the host's reading), which
 *  `setClockOf` rewrites. */
async function testLocationRuns(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeTestClockFile(root, new Date());
  return join(root, 'runs');
}
async function clockedJsonStore(prefix: string): Promise<JsonFileStore> {
  return new JsonFileStore(await testLocationRuns(prefix));
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const runsDir = (store as { runsDirPath?: string }).runsDirPath;
  if (runsDir === undefined) throw new Error('setClockOf: this store is not a JSON store');
  await writeTestClockFile(dirname(runsDir), t);
}

const CHANGELOG = join(dirname(fileURLToPath(import.meta.url)), '../../../../CHANGELOG.md');

/** (a) red when the CHANGELOG no longer holds the sentence word for word; (b) prints it. */
function changelogSays(sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(CHANGELOG, 'utf8')),
    `CHANGELOG.md no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `q` (a question, 60 s, `on_expiry` as given, default `approve`), then `after` (`auto`). */
function gated(onExpiry: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id: `lag-${onExpiry}`,
    name: 'lag',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

describe('#625 PR-2a, F1 — the late answer says how late it was', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = await clockedJsonStore('realm-lag-625-');
  });

  /** A run at its question; `at(ms)` is the instant `ms` after the question's time was up. */
  async function atQuestion(d: WorkflowDefinition) {
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).record.pending_gate!;
    const expiresAt = gate.expires_at!;
    const at = (ms: number) => new Date(new Date(expiresAt).getTime() + ms);
    return { runId: run.id, gateId: gate.gate_id, expiresAt, at };
  }

  it('the one formatter: seconds under a minute (never 0m), then minutes, hours and minutes, days and hours; a negative duration is 0s', () => {
    changelogSays(
      "The expiry line says how long before the call the question's time was up — `had expired 15s before this call`, in seconds under a minute, then minutes, hours and days — on every call that carries an expiry out",
    );
    changelogSays('Core exports the one formatter, `formatDuration`.');
    const cases: Array<[number, string]> = [
      [-5_000, '0s'],
      [0, '0s'],
      [15_000, '15s'],
      [59_999, '59s'],
      [60_000, '1m'],
      [3_599_999, '59m'],
      [3_600_000, '1h 0m'],
      [86_399_999, '23h 59m'],
      [86_400_000, '1d 0h'],
      [3 * 86_400_000 + 5 * 3_600_000, '3d 5h'],
    ];
    // (a) red when core exports no `formatDuration`, or a form changes (`0m` under a minute, as the
    //     older formatters say); (b) prints each duration with what it was written as.
    const format = (core as { formatDuration?: (ms: number) => string }).formatDuration;
    expect(cases.map(([ms]) => [ms, format?.(ms) ?? '<no formatDuration>'])).toEqual(cases);
  });

  it.each([
    ['settle_default', 'approve', 'ok'],
    ['settle_default', 'reject', 'error'],
    ['abort', 'approve', 'error'],
  ] as const)(
    'submitHumanResponse, %s, the answer %s: the line names the call and the lag (15s); the expiry receipt carries expired_at and the lag (#729 PR-0, T-2: no longer error_details) — on both store kinds',
    async (onExpiry, choice, status) => {
      changelogSays(
        "A late answer's expiry is the reply's `expiry` receipt (`ExpiryReceipt`: `gate_id`, `step`, `on_expiry`, `choice`, `enacted_via`, `by_this_call`, `expired_at`, `overdue`); `error_details` no longer carries `expired_at` or `overdue_ms`.",
      );
      // #715 (b): the legacy store kind (no `settleStep`) is gone — one kind left.
      for (const legacy of [false]) {
        const d = gated(onExpiry);
        const { runId, gateId, expiresAt, at } = await atQuestion(d);
        await setClockOf(store, at(15_000));
        const reply = await submitHumanResponse(store, d, {
          runId,
          gateId,
          choice,
        });
        const did =
          onExpiry === 'settle_default'
            ? "settle_default: the default choice 'approve' was recorded"
            : 'abort: the run ended';
        // (a) red when the line drops the lag, says it in minutes (`0m`), or the reply does not carry
        //     the question's `expires_at` and the lag in milliseconds; (b) prints the line and fields.
        expect({
          legacy,
          status: reply.status,
          line: reply.warnings[0],
          expired_at: reply.expiry?.expired_at,
          overdue: reply.expiry?.overdue,
          by_this_call: reply.expiry?.by_this_call,
          details: [reply.error_details?.['expired_at'], reply.error_details?.['overdue_ms']],
        }).toEqual({
          legacy,
          status,
          line: `gate '${gateId}' on 'q' had expired 15s before this call — this submitHumanResponse call first carried out its declared ${did} (enacted_via: submitHumanResponse).`,
          expired_at: expiresAt,
          overdue: { ms: 15_000 },
          by_this_call: true,
          details: [undefined, undefined],
        });
      }
    },
  );

  it.each([
    ['advanceRun', 59_000, '59s'],
    ['executeStep', 61_000, '1m'],
    ['advanceRun', 2 * 3_600_000 + 7 * 60_000, '2h 7m'],
  ] as const)(
    '%s carries out an expired question %ims late: its line says %s',
    async (entry, lateBy, words) => {
      changelogSays(
        "now reads `gate '<g>' on '<s>' had expired <how long> before this call — this <call> call first carried out its declared settle_default: the default choice '<c>' was recorded (enacted_via: <via>).`",
      );
      const d = gated('settle_default');
      const { runId, gateId, at } = await atQuestion(d);
      await setClockOf(store, at(lateBy));
      const reply =
        entry === 'advanceRun'
          ? await advanceRun(store, d, { runId })
          : await executeStep(store, d, {
              runId,
              command: 'after',
              input: {},
              dispatcher: async () => ({}),
            });
      // (a) red when the call's line drops the lag or writes it in another form; (b) prints the
      //     reply's expiry lines.
      expect(reply.warnings.filter((w) => w.includes('had expired'))).toEqual([
        `gate '${gateId}' on 'q' had expired ${words} before this call — this ${entry} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${entry}).`,
      ]);
    },
  );
});
