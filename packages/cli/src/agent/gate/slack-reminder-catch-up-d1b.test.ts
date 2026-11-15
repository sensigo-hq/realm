// slack-reminder-catch-up-d1b.test.ts — issue #597 D1b, through `realm agent`'s Slack gate handler
// (`createSlackGateHandler`): the catch-up's signal is the question post's TAKEOVER (a stopped
// writer's file found and taken over, #729 PR-6b), never a first-time post (which also makes a file).
// The signal travels from the question post through `handleBidirectionalGate` to the reminders; with
// a store that keeps no ledger (`outbound` null or absent) no catch-up is sent and every reminder
// posts as before.
//
// The store is an `InMemoryStore` on a wake clock (the question opens at OPENED, the agent attaches 25
// minutes later); Slack is a stubbed `fetch`; the stopped writer is a pid that has exited.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  executeStep,
  submitHumanResponse,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { createSlackGateHandler } from './slack-gate-notifier.js';
import { slackPostPath } from './slack-post-file.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock, type WakeClock } from '../test-support/wake-clock.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

const OPENED_MS = Date.parse('2033-01-01T00:00:00.000Z');
const MIN = 60_000;
const plus = (ms: number): Date => new Date(OPENED_MS + ms);
const CHANNEL = 'C123';
const POST_TS = '1700000000.000100';
const OLD_TS = '1600000000.000900';

const DEF: WorkflowDefinition = {
  id: 'catch-up-d1b',
  name: 'catch-up-d1b',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], reminder_seconds: 600, reminder_max: 3 },
    },
  },
} as WorkflowDefinition;

interface Body {
  thread_ts?: string;
  text?: string;
  blocks?: unknown[];
}

let home: string;
let lines: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-d1b-catch-up-'));
  lines = [];
  for (const kind of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
  }
  fetchSpy = vi.fn(() => Promise.resolve(slackResponse({ json: { ok: true, ts: POST_TS } })));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const bodies = (): Body[] =>
  fetchSpy.mock.calls
    .filter(([url]) => String(url).includes('chat.postMessage'))
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Body);
const shown = (): string =>
  `posts: ${JSON.stringify(bodies(), null, 2)}\nprinted: ${JSON.stringify(lines, null, 2)}`;

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

/** A store on a wake clock (its ledger as `outbound` says), its question opened at OPENED. */
async function opened(
  outbound: 'kept' | 'null' | 'absent',
): Promise<{ clock: WakeClock; store: RunStore; runId: string; gate: PendingGate }> {
  const clock = wakeClock(plus(0));
  const memory =
    outbound === 'null'
      ? new InMemoryStore({ clock, outbound: null })
      : new InMemoryStore({ clock });
  // A store that has no `outbound` member at all (as a store written before the ledger existed).
  const store: RunStore =
    outbound === 'absent'
      ? (Object.create(memory, { outbound: { value: undefined } }) as RunStore)
      : memory;
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const step = await executeStep(store, DEF, {
    runId: record.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  if (step.status !== 'confirm_required') throw new Error(`fixture: ${step.status}`);
  return {
    clock,
    store,
    runId: record.id,
    gate: (await store.get(record.id)).record.pending_gate!,
  };
}

/** A post file naming a `realm agent` that has stopped (a pid that ran and exited). */
function seedStoppedWriter(runId: string, gate: PendingGate): void {
  const path = slackPostPath(home, runId, gate.gate_id);
  mkdirSync(dirname(path), { recursive: true });
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (pid === undefined) throw new Error('fixture: no pid');
  writeFileSync(
    path,
    `${JSON.stringify({ channel: CHANNEL, ts: OLD_TS, pid, host: hostname(), id: 'stopped' })}\n`,
  );
}

/**
 * `realm agent`'s handler attached at OPENED + 25 min (occurrences 1 and 2 passed); the thread posts
 * it made by then, and after the clock reaches `later` when given. The question is then answered.
 */
async function attach(
  o: { store: RunStore; clock: WakeClock; runId: string; gate: PendingGate },
  later?: Date,
): Promise<{ atAttach: string[]; afterLater: string[]; questionPosts: number }> {
  await o.clock.set(plus(25 * MIN));
  const handled = createSlackGateHandler({
    store: o.store,
    definition: DEF,
    provider: {} as never,
    botToken: 'xoxb-d1b-fake-token',
    channelId: CHANNEL,
    pollIntervalMs: 0,
    home,
  })(o.runId, o.gate);
  await until(() => lines.some((l) => l.includes('Waiting for approval')));
  await new Promise((r) => setTimeout(r, 50));
  const thread = (): string[] =>
    bodies()
      .filter((b) => b.thread_ts !== undefined)
      .map((b) => b.text!);
  const atAttach = thread();
  if (later !== undefined) {
    await o.clock.set(later);
    await new Promise((r) => setTimeout(r, 50));
  }
  const afterLater = thread();
  const questionPosts = bodies().filter((b) => b.blocks !== undefined).length;
  await submitHumanResponse(o.store, DEF, {
    runId: o.runId,
    gateId: o.gate.gate_id,
    choice: 'approve',
    route: 'cli',
  });
  await handled;
  return { atAttach, afterLater, questionPosts };
}

const open = (age: string): string =>
  `⏰ gate \`confirm\` has been open for ${age} (since 2033-01-01T00:00:00Z). Please respond.`;

describe('#597 D1b — the catch-up’s signal is the question post’s takeover', () => {
  it('a takeover: ONE catch-up reminder in the old thread with the true age; the ledger has occurrence 2 sent and 1 skipped', async () => {
    // (a) red when the takeover's flag does not reach the reminders (no catch-up), two are sent, or
    //     another thread is used; (b) prints the posts and the lines.
    const o = await opened('kept');
    seedStoppedWriter(o.runId, o.gate);
    const got = await attach(o);
    const rows = await (o.store as InMemoryStore).outbound!.read(o.runId);
    expect(
      {
        ...got,
        // The reminders' thread (after the answer the handler also replies in it).
        threads: bodies()
          .filter((b) => b.thread_ts !== undefined && b.text?.includes('Please respond.'))
          .map((b) => b.thread_ts),
        rows: rows.map((r) => [r.occurrence, r.status]),
      },
      shown(),
    ).toEqual({
      atAttach: [open('25m')],
      afterLater: [open('25m')],
      questionPosts: 0,
      threads: [OLD_TS],
      rows: [[2, 'sent']],
    });
  }, 20_000);

  it('a first-time post by a late agent (it makes its file too): no catch-up', async () => {
    // (a) red when a first-time post is read as a takeover (`postFile` taken for the signal); (b)
    //     prints the posts and the lines.
    const o = await opened('kept');
    const got = await attach(o);
    expect(got, shown()).toEqual({ atAttach: [], afterLater: [], questionPosts: 1 });
  }, 20_000);

  it('a store with no ledger (`outbound` null, or absent): a takeover sends no catch-up, and the next reminder posts as before', async () => {
    // (a) red when a store with no ledger gets a catch-up, or its reminders stop; (b) prints the
    //     posts and the lines.
    const got: Record<string, unknown> = {};
    for (const outbound of ['null', 'absent'] as const) {
      fetchSpy.mockClear();
      lines.length = 0;
      const o = await opened(outbound);
      seedStoppedWriter(o.runId, o.gate);
      got[outbound] = await attach(o, plus(30 * MIN));
    }
    expect(got, shown()).toEqual({
      null: { atAttach: [], afterLater: [open('30m')], questionPosts: 0 },
      absent: { atAttach: [], afterLater: [open('30m')], questionPosts: 0 },
    });
  }, 30_000);
});
