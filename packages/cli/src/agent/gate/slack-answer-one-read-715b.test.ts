// slack-answer-one-read-715b.test.ts — issue #715 (b) Amendment 12 (b) (03 §B.2, D-29, D6-17): the
// Slack notifier's answer path judges the lines it prints after an answer on the snapshot the engine
// judged its reply on (`judgedSnapshotOf`) and never reads the run again for them. Both paths whose
// reload commit 3 removed: a LATE answer (the expiry carried out, the lines say so) and an on-time
// answer whose guard ENDS the run (the ending's lines).
//
// The instrument: the store is wrapped, and every `get` records the function that called it (the
// first stack frame outside this file and core). The answer's own write is the first `settleStep`
// after the thread's reply. Scope (verify-first: the gate poll reads too, every `pollIntervalMs`):
// the reads that count are those the ANSWER PATH makes — `processCandidate`'s — after that write;
// the gate poll's (`pollUntilGateResolved`) and the closed-notice read are not the answer path. The
// instrument accounts for its input: it must see `processCandidate`'s one read BEFORE the answer
// (the F9 `before` read), or it is blind.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { handleBidirectionalGate } from './slack-gate-notifier.js';
import { startSlackGateServer } from './slack-gate-server.js';
import type { SlackGateEvent } from './slack-gate-server.js';
import { LlmProvider } from '../providers/llm-provider.js';
import { slackResponse } from '../test-support/slack-response.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./gate-expiry-timer.js', () => ({
  scheduleGateExpiryTimer: vi.fn(() => (): void => {}),
}));

const T = Date.parse('2031-03-04T05:06:07.000Z');

/** `confirm` (a question, 1 h, abort on expiry), then `check` (a guard: abort unless approved), then `finish`. */
const DEF: WorkflowDefinition = {
  id: 'slack-one-read-715b',
  name: 'slack-one-read-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 3600, on_expiry: 'abort' },
    },
    check: {
      description: 'Check',
      execution: 'guard',
      depends_on: ['confirm'],
      abort_unless: ["confirm.choice == 'approve'"],
      abort_message: 'Not approved.',
    },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
  },
};

/** The first frame outside this file and core's own code: the function that asked for the read. */
function caller(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const frame = frames.find(
    (l) =>
      l.trim().startsWith('at ') &&
      !l.includes('slack-answer-one-read-715b') &&
      !l.includes('/core/dist/') &&
      !l.includes('/testing/dist/') &&
      !l.includes('node:internal'),
  );
  return /at (?:async )?([\w.<>$]+)/.exec(frame ?? '')?.[1] ?? '(none)';
}

interface Recorded {
  store: RunStore;
  /** Every `get`, in order: its caller, and whether the answer's write had returned by then. */
  gets: Array<{ by: string; afterAnswer: boolean }>;
}

/** A store that records every `get`'s caller, and when the first settle after the thread's reply ends. */
function recorded(inner: InMemoryStore, armed: { on: boolean }): Recorded {
  const gets: Recorded['gets'] = [];
  let answered = false;
  const store = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'get') {
        return async (runId: string) => {
          gets.push({ by: caller(), afterAnswer: answered });
          return target.get(runId);
        };
      }
      if (prop === 'settleStep') {
        return async (...a: Parameters<InMemoryStore['settleStep']>) => {
          const out = await target.settleStep(...a);
          if (armed.on) answered = true;
          return out;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as RunStore;
  return { store, gets };
}

let printed: string[];

beforeEach(() => {
  printed = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slackResponse({ json: { ok: true } })));
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
    printed.push(String(m));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Opens the question on a settable store clock; `lateBy` moves the clock past its deadline. */
async function opened(
  lateBy: number,
): Promise<{ inner: InMemoryStore; runId: string; gate: PendingGate }> {
  const clock = settableClock(new Date(T));
  const inner = new InMemoryStore({ clock });
  const { record } = await inner.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  await advanceRun(inner, DEF, { runId: record.id });
  const gate = (await inner.get(record.id)).record.pending_gate!;
  if (lateBy > 0) await clock.set(new Date(Date.parse(gate.expires_at!) + lateBy));
  return { inner, runId: record.id, gate };
}

/** Answers `text` in the thread; returns the reads the answer path made after its write. */
async function answer(
  inner: InMemoryStore,
  runId: string,
  gate: PendingGate,
  text: string,
): Promise<{ beforeByAnswerPath: number; afterByAnswerPath: string[] }> {
  const armed = { on: false };
  const { store, gets } = recorded(inner, armed);
  let onEvent: ((event: SlackGateEvent) => void) | undefined;
  vi.mocked(startSlackGateServer).mockImplementationOnce((opts) => {
    onEvent = opts.onEvent;
    return { close: vi.fn() };
  });
  const waiting = handleBidirectionalGate({
    gate,
    runId,
    definition: DEF,
    store,
    provider: new (class extends LlmProvider {
      callStep = vi.fn();
    })(),
    slackBotToken: 'xoxb-test',
    slackChannelId: 'C123',
    gateThreadTs: '1234567890.000',
    slackSigningSecret: 'secret',
    slackEventsPort: 3100,
    gateReminderIntervalMs: 999_999,
    gateEscalationThresholdMs: 999_999,
    pollIntervalMs: 0,
  });
  if (onEvent === undefined) throw new Error('fixture: the notifier registered no event handler');
  armed.on = true;
  onEvent({ event_id: 'E1', thread_ts: '1234567890.000', user: 'U1', text, ts: '1234567890.001' });
  await waiting;
  const answerPath = gets.filter((g) => g.by === 'processCandidate');
  return {
    beforeByAnswerPath: answerPath.filter((g) => !g.afterAnswer).length,
    afterByAnswerPath: answerPath.filter((g) => g.afterAnswer).map((g) => g.by),
  };
}

describe('#715 (b) Amendment 12 (b) — the Slack answer path reads the run once, before the answer', () => {
  it('a late answer (the expiry carried out): its lines are printed, and nothing on the answer path reads the run after the write', async () => {
    // (a) red when the late path reads the run again after the answer (`(await store.get(runId)).record`
    //     restored before describeAnswerEnding); (b) prints the reads and the printed lines.
    const { inner, runId, gate } = await opened(60_000);
    const reads = await answer(inner, runId, gate, 'approve');
    expect({
      ...reads,
      saidNotRecorded: printed.some(
        (l) => l.includes('was not recorded') || l.includes('first carried out'),
      ),
    }).toEqual({ beforeByAnswerPath: 1, afterByAnswerPath: [], saidNotRecorded: true });
  });

  it('an on-time answer whose guard ends the run: the ending’s lines are printed, and nothing on the answer path reads the run after the write', async () => {
    // (a) red when the ended path reads the run again after the answer; (b) prints the reads and
    //     whether the guard's ending was printed.
    const { inner, runId, gate } = await opened(0);
    const reads = await answer(inner, runId, gate, 'reject');
    expect({
      ...reads,
      saidEnded: printed.some((l) => l.includes("'check'")),
    }).toEqual({ beforeByAnswerPath: 1, afterByAnswerPath: [], saidEnded: true });
  });
});
