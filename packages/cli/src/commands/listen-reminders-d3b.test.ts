// listen-reminders-d3b.test.ts — issue #597 D3b: `realm listen --send-reminders`. Its own poll runner
// and the sender: each pass reads the runs waiting at a question and, for each one whose posting
// `realm agent` is gone (its post file's writer has stopped), posts the due reminder or nudge into the
// question's own thread through the outbound ledger; a row's retries wait longer each time; a
// Slack-wide refusal pauses that workflow until a probe passes.
//
// The store is a real SQLite home (`makeTempHome`) on a settable clock (its ledger is real); Slack is
// a stubbed `fetch` whose answers copy Slack's documented shapes (`{ok:true}`, `{ok:false,error}`; a
// call past its deadline, made short in this file, is a timeout; a thrown fetch is a network error).
// The post files are written under the home as `realm agent` writes them. Every value is a fake.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A Slack call that does not answer times out at once (the real deadline is 30 s).
vi.mock('../agent/gate/slack-call.js', async (orig) => ({
  ...(await orig<typeof import('../agent/gate/slack-call.js')>()),
  SLACK_CALL_DEADLINE_MS: 50,
}));

import { settableClock, type SettableClock } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  writtenSnapshot,
  type OutboundLeaseRequest,
  type OutboundLedger,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import {
  makePollRunner,
  makeReminderPass,
  reminderSenderOf,
  REMINDER_POLL_MS,
  type ReminderWorkflow,
} from './listen-reminders.js';
import {
  listenCommand,
  startListen,
  type ListenDeps,
  type Logger,
  type WorkflowEntry,
} from './listen.js';
import { startGateReminderTimers } from '../agent/gate/slack-gate-notifier.js';
import { slackPostPath } from '../agent/gate/slack-post-file.js';
import { slackResponse } from '../agent/test-support/slack-response.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const OPENED = '2033-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);
const MIN = 60_000;
const at = (ms: number): Date => new Date(OPENED_MS + ms);
const tsOf = (d: Date): string => (d.getTime() / 1000).toFixed(6);
const CHANNEL = 'C123';
const WF = 'd3b-a';
const WF2 = 'd3b-b';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const def = (id: string): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      review: { description: 'r', execution: 'auto', depends_on: [], trust: 'human_confirmed' },
    },
  }) as WorkflowDefinition;

/** What the fake Slack saw, and what it answers next. */
interface Slack {
  posts: Array<{ channel: string; thread_ts: string; text: string }>;
  auths: number;
  /** The answer to a `chat.postMessage` (default `{ok:true}`), given the call. */
  post: (url: string, init: RequestInit) => Promise<Response>;
  /** The answer to an `auth.test` (default `{ok:true}`). */
  auth: () => Promise<Response>;
}
let slack: Slack;
const ok = (): Promise<Response> => Promise.resolve(slackResponse({ json: { ok: true } }));
const refused = (error: string) => (): Promise<Response> =>
  Promise.resolve(slackResponse({ json: { ok: false, error } }));
/** A call that never answers: the call's own deadline turns it into a timeout. */
const hangs = (): Slack['post'] => (_url, init) =>
  new Promise((_, reject) =>
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
  );

beforeEach(() => {
  slack = { posts: [], auths: 0, post: ok, auth: ok };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith('auth.test')) {
        slack.auths += 1;
        return slack.auth();
      }
      slack.posts.push(JSON.parse(init.body as string));
      return slack.post(url, init);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Lines {
  info: string[];
  warn: string[];
  error: string[];
}
const capture = (): Logger & { lines: Lines } => {
  const lines: Lines = { info: [], warn: [], error: [] };
  return {
    lines,
    debug: () => {},
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m, d) => lines.error.push(`${m} ${JSON.stringify(d)}`),
  };
};

interface Rig {
  readonly h: TempHome;
  readonly clock: SettableClock;
  readonly store: RunStore;
  readonly ledger: OutboundLedger;
  readonly logger: ReturnType<typeof capture>;
}

async function rig(): Promise<Rig> {
  const clock = settableClock(at(0));
  const h = await makeTempHome({ clock });
  onTestFinished(() => h.cleanup());
  for (const id of [WF, WF2]) await h.home.workflowStore.register(def(id));
  return { h, clock, store: h.home.runStore, ledger: h.home.runStore.outbound!, logger: capture() };
}

type FileKind = 'stopped' | 'running' | 'none' | 'other-host' | 'bad-ts';

/** A run of `workflowId` waiting at `review` (its question opened at OPENED), and its post file. */
async function question(
  r: Rig,
  fields: Record<string, unknown> = {},
  o: { file?: FileKind; workflowId?: string } = {},
): Promise<{ runId: string; gate: PendingGate }> {
  const { record } = await r.store.create({
    workflowId: o.workflowId ?? WF,
    workflowVersion: 1,
    params: {},
  });
  const gate = {
    gate_id: `g-${record.id.slice(0, 8)}`,
    step_name: 'review',
    preview: { headline: 'Deploy' },
    choices: ['approve', 'reject'],
    opened_at: OPENED,
    ...fields,
  } as unknown as PendingGate;
  await r.store.update({ ...record, in_progress_steps: ['review'], pending_gate: gate });
  const kind = o.file ?? 'stopped';
  if (kind !== 'none') {
    const path = slackPostPath(r.h.path, record.id, gate.gate_id);
    mkdirSync(dirname(path), { recursive: true });
    // A writer that runs: another live process (the parent); one that stopped: a pid that exited.
    const pid = kind === 'running' ? process.ppid : spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(
      path,
      `${JSON.stringify({
        channel: CHANNEL,
        ts: kind === 'bad-ts' ? 'not-a-ts' : tsOf(at(0)),
        pid,
        host: kind === 'other-host' ? 'another-machine' : hostname(),
        id: kind === 'running' ? 'the-live-agent' : 'stopped',
      })}\n`,
    );
  }
  return { runId: record.id, gate };
}

const workflow = (id: string, extra: Partial<ReminderWorkflow> = {}): ReminderWorkflow => ({
  definition: def(id),
  botToken: 'xoxb-d3b-fake',
  channelId: CHANNEL,
  reminderIntervalMs: 10 * MIN,
  escalationThresholdMs: 999 * MIN,
  ...extra,
});

/** The sender's pass over the rig, covering WF (and WF2 when asked). */
function passOf(
  r: Rig,
  o: { ledger?: OutboundLedger; workflows?: string[]; extra?: Partial<ReminderWorkflow> } = {},
) {
  const workflows = new Map((o.workflows ?? [WF]).map((id) => [id, workflow(id, o.extra)]));
  const pass = makeReminderPass({
    runStore: r.store,
    outbound: o.ledger ?? r.ledger,
    home: r.h.path,
    workflows,
    logger: r.logger,
  });
  return (): Promise<boolean> => pass(() => true);
}

const command = (runId: string, gateId: string): string =>
  `realm run respond ${runId} --gate ${gateId} --choice &lt;one of: approve, reject&gt;`;
const notReading = (age: string, runId: string, gateId: string, who = ''): string =>
  `${who}⏰ gate \`review\` has been open for ${age} (since 2033-01-01T00:00:00Z). Realm is not reading replies in this thread right now — to respond, open a terminal and run:\n\`\`\`${command(runId, gateId)}\`\`\``;

async function statusOf(r: Rig, runId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of await r.ledger.read(runId))
    out[row.type === 'escalation' ? 'e' : String(row.occurrence)] = `${row.status}/${row.attempts}`;
  return out;
}

describe('#597 D3b — the post file and the due item', { timeout: 30_000 }, () => {
  it('the five post files: `stopped` is reminded in its own thread; `running` and `none` are silent; another host and an unreadable `ts` print ONE line each, however many passes', async () => {
    // (a) red when a running agent's question is reminded, an absent file logs, an unusable one is
    //     reminded or logged twice, or the post goes to another thread; (b) prints posts and lines.
    const r = await rig();
    const stopped = await question(r);
    await question(r, {}, { file: 'running' });
    await question(r, {}, { file: 'none' });
    const other = await question(r, {}, { file: 'other-host' });
    const badTs = await question(r, {}, { file: 'bad-ts' });
    await r.clock.set(at(25 * MIN));
    const pass = passOf(r);
    await pass();
    await pass();
    expect({ posts: slack.posts, warn: [...r.logger.lines.warn].sort() }).toEqual({
      posts: [
        {
          channel: CHANNEL,
          thread_ts: tsOf(at(0)),
          text: notReading('25m', stopped.runId, stopped.gate.gate_id),
        },
      ],
      warn: [
        `listen: reminders: no usable post for run ${other.runId}, question ${other.gate.gate_id}: not reminded`,
        `listen: reminders: no usable post for run ${badTs.runId}, question ${badTs.gate.gate_id}: not reminded`,
      ].sort(),
    });
  });

  it("a workflow that is not covered is silent; only the grid's due item is posted (the nudge, with the owner first)", async () => {
    // (a) red when an uncovered workflow is reminded, or an item other than the due one is posted;
    //     (b) prints the posts.
    const r = await rig();
    await question(r, {}, { workflowId: WF2 });
    const owned = await question(r, { owner: '@ana' });
    await r.clock.set(at(40 * MIN));
    await passOf(r, { extra: { escalationThresholdMs: 30 * MIN } })();
    expect(slack.posts.map((p) => p.text)).toEqual([
      notReading('40m', owned.runId, owned.gate.gate_id, '@ana — '),
    ]);
  });

  it('never the final of an `on_expiry` gate (the authored final and the one-shot final); the one-shot final of a finding-only gate IS posted, without a command', async () => {
    // (a) red when a final of a question its expiry closes is posted ("the run will be stopped"), or
    //     a finding-only final is withheld; (b) prints the posts.
    const r = await rig();
    const authored = await question(r, {
      reminder_seconds: 600,
      reminder_max: 3,
      expires_at: at(30 * MIN).toISOString(),
      on_expiry: 'abort',
    });
    const oneShot = await question(r, {
      expires_at: at(5 * MIN).toISOString(),
      on_expiry: 'abort',
    });
    await question(r, { expires_at: at(5 * MIN).toISOString(), timeout_seconds: 300 });
    await r.clock.set(at(35 * MIN));
    await passOf(r)();
    // The `--sweep-expired-gates` help: "--send-reminders only posts reminders" — the two questions
    // past their limit are still waiting after the pass (no expiry carried out).
    const phases = await Promise.all(
      [authored, oneShot].map(async (q) => (await r.store.get(q.runId)).record.run_phase),
    );
    expect({ posts: slack.posts.map((p) => p.text), phases }).toEqual({
      posts: [
        '⏰ gate `review` expired 30m ago (2033-01-01T00:05:00Z) — nothing will be done automatically; it is still waiting for a response.',
      ],
      phases: ['gate_waiting', 'gate_waiting'],
    });
  });

  it('the age: a reminder sent at most 60 s late reads its own time (10m), one sent later the real one (11m)', async () => {
    // (a) red when the sender composes without the agent's 60-second grace, or always at the item's
    //     instant; (b) prints the two texts' first sentences.
    const ages: string[] = [];
    for (const late of [60_000, 61_000]) {
      const r = await rig();
      await question(r);
      await r.clock.set(at(10 * MIN + late));
      const before = slack.posts.length;
      await passOf(r, { extra: { escalationThresholdMs: 999 * MIN } })();
      ages.push(...slack.posts.slice(before).map((p) => p.text.split('.')[0]!));
    }
    expect(ages).toEqual([
      '⏰ gate `review` has been open for 10m (since 2033-01-01T00:00:00Z)',
      '⏰ gate `review` has been open for 11m (since 2033-01-01T00:00:00Z)',
    ]);
  });

  it('the console: a refused post, a timeout and a rate limit print nothing there (the lines go through the logger)', async () => {
    // (a) red when the sender's Slack calls print the agent's console lines; (b) prints those lines.
    const printed: unknown[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => void printed.push(a));
    vi.spyOn(console, 'log').mockImplementation((...a) => void printed.push(a));
    // Slack's 429 with `Retry-After: 0` (within the call's deadline): retried once, then refused.
    const limited = (): Promise<Response> =>
      Promise.resolve(
        slackResponse({ status: 429, headers: { 'Retry-After': '0' }, json: { ok: false } }),
      );
    for (const answer of [refused('thread_locked'), hangs(), limited]) {
      const r = await rig();
      await question(r);
      await r.clock.set(at(25 * MIN));
      slack.post = answer;
      await passOf(r)();
    }
    expect({ printed, posts: slack.posts.length }).toEqual({ printed: [], posts: 4 });
  });

  it('a `failed` row posts nothing and prints no line', async () => {
    // (a) red when a failed row is posted again or logged; (b) prints the posts and lines.
    const r = await rig();
    const q = await question(r);
    slack.post = refused('channel_not_found');
    await r.clock.set(at(25 * MIN));
    await passOf(r)();
    const first = slack.posts.length;
    slack.post = ok;
    await r.clock.set(at(3 * 60 * MIN));
    // The second pass through a ledger that counts its leases: the grid still names the failed item
    // due (only `sent` ends an item, D3a), so the sender asks once and the ledger refuses (`skipped`):
    // nothing posted, nothing printed, the row unchanged.
    let leases = 0;
    const counting: OutboundLedger = {
      lease: (id, req) => {
        leases += 1;
        return r.ledger.lease(id, req);
      },
      mark: (id, req) => r.ledger.mark(id, req),
      read: (id) => r.ledger.read(id),
      statAllForRun: (id) => r.ledger.statAllForRun(id),
      deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
    };
    await passOf(r, { ledger: counting })();
    expect({
      first,
      leases,
      posts: slack.posts.length,
      rows: await statusOf(r, q.runId),
      lines: r.logger.lines,
    }).toEqual({
      first: 1,
      leases: 1,
      posts: 1,
      rows: { '1': 'failed/1' },
      lines: { info: [], warn: [], error: [] },
    });
  });
});

describe('#597 D3b — exactly once, through the ledger', { timeout: 30_000 }, () => {
  it('an agent that takes the question over in the same instant: ONE post in all', async () => {
    // (a) red when the sender posts without the ledger (two posts); (b) prints the posts.
    const r = await rig();
    const q = await question(r);
    await r.clock.set(at(25 * MIN));
    const { record } = await r.store.get(q.runId);
    const clear = startGateReminderTimers(
      'xoxb-d3b-fake',
      CHANNEL,
      tsOf(at(0)),
      writtenSnapshot(record, at(25 * MIN)),
      10 * MIN,
      999 * MIN,
      r.clock,
      q.runId,
      undefined,
      false,
      { outbound: r.ledger, gateId: q.gate.gate_id, takenOver: true },
    );
    await passOf(r)();
    await settle();
    clear();
    await passOf(r)();
    expect(slack.posts.length).toBe(1);
  });

  it('another token leases the item between the sender’s read and its lease: nothing is posted', async () => {
    // (a) red when the sender posts without leasing through `sendOnce`; (b) prints the posts.
    const r = await rig();
    const q = await question(r);
    await r.clock.set(at(25 * MIN));
    const what: OutboundLeaseRequest['what'] = {
      type: 'reminder',
      gateId: q.gate.gate_id,
      occurrence: 1,
    };
    const ledger: OutboundLedger = {
      lease: (id, req) => r.ledger.lease(id, req),
      mark: (id, req) => r.ledger.mark(id, req),
      statAllForRun: (id) => r.ledger.statAllForRun(id),
      deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
      read: async (id) => {
        const rows = await r.ledger.read(id);
        await r.ledger.lease(id, { what, leaseToken: 'another-sender', leaseSeconds: 120 });
        return rows;
      },
    };
    await passOf(r, { ledger })();
    expect(slack.posts).toEqual([]);
  });
});

/** A row leased `n` times, each lease lapsed before the next; answers the last lease's deadline. */
async function leasedTimes(r: Rig, runId: string, gateId: string, n: number): Promise<number> {
  const what = { type: 'reminder', gateId, occurrence: 1 } as const;
  let deadline = 0;
  for (let i = 0; i < n; i += 1) {
    if (deadline !== 0) await r.clock.set(new Date(deadline + 1));
    const leased = await r.ledger.lease(runId, { what, leaseToken: `t${i}`, leaseSeconds: 120 });
    if (!leased.applied) throw new Error(`fixture: lease ${i + 1} refused: ${leased.reason}`);
    deadline = Date.parse(leased.entry.lease_deadline);
  }
  return deadline;
}

describe('#597 D3b — row spacing and the cap', { timeout: 30_000 }, () => {
  for (const [attempts, waitMin] of [
    [1, 1],
    [2, 2],
    [7, 64],
  ] as const) {
    it(`attempts ${attempts}: leased again at lease_deadline + ${waitMin} min, not earlier`, async () => {
      // (a) red when the wait is shorter or longer than 2^(attempts − 1) minutes; (b) prints the
      //     posts and the row.
      const r = await rig();
      const q = await question(r);
      await r.clock.set(at(10 * MIN));
      const deadline = await leasedTimes(r, q.runId, q.gate.gate_id, attempts);
      const pass = passOf(r);
      await r.clock.set(new Date(deadline + waitMin * MIN - 1));
      await pass();
      const early = slack.posts.length;
      await r.clock.set(new Date(deadline + waitMin * MIN));
      await pass();
      expect({ early, then: slack.posts.length, rows: await statusOf(r, q.runId) }).toEqual({
        early: 0,
        then: 1,
        rows: { '1': `sent/${attempts + 1}` },
      });
    });
  }

  it('attempts 8: no lease is taken (the 9th is not made), ONE line per process', async () => {
    // (a) red when a 9th attempt is made, or the line is missing or repeated; (b) prints posts,
    //     rows and lines.
    const r = await rig();
    const q = await question(r);
    await r.clock.set(at(10 * MIN));
    const deadline = await leasedTimes(r, q.runId, q.gate.gate_id, 8);
    const pass = passOf(r);
    await r.clock.set(new Date(deadline + 200 * MIN));
    await pass();
    await pass();
    expect({
      posts: slack.posts.length,
      rows: await statusOf(r, q.runId),
      warn: r.logger.lines.warn,
    }).toEqual({
      posts: 0,
      rows: { '1': 'pending/8' },
      warn: [
        `listen: reminders: reminder 1 of run ${q.runId} not confirmed after 8 tries; not tried again`,
      ],
    });
  });
});

describe('#597 D3b — a Slack-wide problem pauses the workflow', { timeout: 30_000 }, () => {
  for (const [label, answer, code] of [
    ['an auth-class code', refused('invalid_auth'), 'invalid_auth'],
    ['`ratelimited`', refused('ratelimited'), 'ratelimited'],
    ['a timeout', hangs(), 'timeout'],
    [
      'an HTTP 5xx',
      () => Promise.resolve(slackResponse({ status: 503, text: '<html>busy</html>' })),
      'HTTP 503',
    ],
  ] as const) {
    it(`${label} cools THAT workflow only: no further lease for it this pass; another workflow still posts`, async () => {
      // (a) red when the code does not pause the workflow, pauses another, or the line is wrong;
      //     (b) prints the posts and lines.
      const r = await rig();
      const a1 = await question(r);
      const a2 = await question(r);
      const b = await question(r, {}, { workflowId: WF2 });
      await r.clock.set(at(25 * MIN));
      slack.post = (url, init) =>
        String(init.body).includes(b.runId) ? ok() : (answer as Slack['post'])(url, init);
      const before = slack.posts.length;
      await passOf(r, { workflows: [WF, WF2] })();
      const auth =
        code === 'invalid_auth' ? '; a changed token needs a restart of realm listen' : '';
      const ofA = slack.posts
        .slice(before)
        .filter((p) => p.text.includes(a1.runId) || p.text.includes(a2.runId));
      expect({
        a: ofA.length,
        b: slack.posts.slice(before).filter((p) => p.text.includes(b.runId)).length,
        warn: r.logger.lines.warn,
      }).toEqual({
        a: 1,
        b: 1,
        warn: [
          `listen: reminders: Slack did not take a reminder for workflow ${WF} (${code}): reminders for it wait; checking again in about 1 min${auth}`,
        ],
      });
    });
  }

  it('the probes: 1, 2, 4 … 30 minutes of the store’s clock; a passing `auth.test` lifts it; the recovery line at the first `sent`, never at the probe; a pause entered again keeps its wait and prints no new line', async () => {
    // (a) red when the cadence is wrong, the recovery line comes at the probe or twice, or a second
    //     entry prints a line or resets the wait; (b) prints the probe times, lines and posts.
    const r = await rig();
    await question(r);
    await r.clock.set(at(25 * MIN));
    slack.post = refused('invalid_auth');
    slack.auth = refused('invalid_auth');
    const pass = passOf(r);
    await pass();
    const probes: number[] = [];
    const t0 = r.clock.now().getTime();
    for (let m = 1; m <= 64; m += 1) {
      await r.clock.set(new Date(t0 + m * MIN));
      const before = slack.auths;
      await pass();
      if (slack.auths > before) probes.push(m);
    }
    // auth.test passes, but the post still fails Slack-wide: entered again, no new line, the wait kept.
    slack.auth = ok;
    await r.clock.set(new Date(t0 + 95 * MIN));
    await pass();
    const linesAfterReentry = [...r.logger.lines.warn, ...r.logger.lines.info];
    // The wait kept: 30 minutes from the re-entry, so no probe a minute before it.
    const authsAtReentry = slack.auths;
    await r.clock.set(new Date(t0 + 124 * MIN));
    await pass();
    const earlyProbes = slack.auths - authsAtReentry;
    slack.post = ok;
    await r.clock.set(new Date(t0 + 125 * MIN));
    await pass();
    expect({
      probes,
      linesAfterReentry,
      earlyProbes,
      info: r.logger.lines.info,
      warn: r.logger.lines.warn.length,
    }).toEqual({
      probes: [1, 3, 7, 15, 31, 61],
      earlyProbes: 0,
      linesAfterReentry: [
        `listen: reminders: Slack did not take a reminder for workflow ${WF} (invalid_auth): reminders for it wait; checking again in about 1 min; a changed token needs a restart of realm listen`,
      ],
      info: [
        `listen: reminders: Slack took a reminder for workflow ${WF} again: reminders for it resume`,
      ],
      warn: 1,
    });
  });

  it('`not_in_channel` on every post with `auth.test` ok: one entry line, no recovery line, one attempt per probe interval, no `auth.test`', async () => {
    // (a) red when `auth.test` lifts a blind pause (a flap: lines and attempts each pass); (b) prints
    //     the attempt times and lines.
    const r = await rig();
    await question(r);
    await question(r);
    await r.clock.set(at(25 * MIN));
    slack.post = refused('not_in_channel');
    const pass = passOf(r);
    await pass();
    const t0 = r.clock.now().getTime();
    const attempts: number[] = [];
    for (let m = 1; m <= 32; m += 1) {
      await r.clock.set(new Date(t0 + m * MIN));
      const before = slack.posts.length;
      await pass();
      for (let i = before; i < slack.posts.length; i += 1) attempts.push(m);
    }
    expect({
      attempts,
      auths: slack.auths,
      info: r.logger.lines.info,
      warn: r.logger.lines.warn.length,
    }).toEqual({
      attempts: [1, 3, 7, 15, 31],
      auths: 0,
      info: [],
      warn: 1,
    });
  });

  it('isolation: a refused code outside the Slack-wide set waits that row only, the second workflow posts in the same pass, ONE line per (workflow, code); a channel-class code marks `failed` and does not cool; an HTTP 4xx is the row’s own', async () => {
    // (a) red when a row's own refusal pauses the workflow, or its line repeats; (b) prints the
    //     posts, lines and rows.
    const r = await rig();
    const a1 = await question(r);
    const a3 = await question(r);
    const a2 = await question(r);
    const b = await question(r, {}, { workflowId: WF2 });
    await r.clock.set(at(25 * MIN));
    slack.post = (_url, init) => {
      const text = String(init.body);
      return text.includes(a1.runId) || text.includes(a3.runId)
        ? refused('thread_locked')()
        : text.includes(a2.runId)
          ? Promise.resolve(slackResponse({ status: 404, text: 'no such thread' }))
          : refused('channel_not_found')();
    };
    await passOf(r, { workflows: [WF, WF2] })();
    // Two questions of one workflow refused with one code: ONE line, naming the first one refused.
    const locked = r.logger.lines.warn.filter((l) => l.includes('(thread_locked)'));
    expect({
      posts: slack.posts.length,
      rows: [
        await statusOf(r, a1.runId),
        await statusOf(r, a3.runId),
        await statusOf(r, a2.runId),
        await statusOf(r, b.runId),
      ],
      locked: locked.map((l) => l.replace(/run \S+ \(/, 'run <run> (')),
      lockedRun: [a1.runId, a3.runId].some((id) => locked[0]?.includes(id)),
      others: r.logger.lines.warn.filter((l) => !l.includes('(thread_locked)')),
    }).toEqual({
      posts: 4,
      rows: [{ '1': 'pending/1' }, { '1': 'pending/1' }, { '1': 'pending/1' }, { '1': 'failed/1' }],
      locked: [
        'listen: reminders: Slack refused reminder 1 of run <run> (thread_locked): tried again later',
      ],
      lockedRun: true,
      others: [
        `listen: reminders: Slack refused reminder 1 of run ${a2.runId} (HTTP 404): tried again later`,
      ],
    });
  });
});

describe('#597 D3b — the outcomes', { timeout: 30_000 }, () => {
  it('a mark that throws: ONE post across two spacing windows, and one line; a lease that throws: one line per process, and the pass goes on', async () => {
    // (a) red when a post whose mark threw is posted again, or a line repeats or is missing; (b)
    //     prints the posts and lines.
    const r = await rig();
    const q = await question(r);
    const busy = new Set([(await question(r)).runId, (await question(r)).runId]);
    await r.clock.set(at(25 * MIN));
    let leases = 0;
    const ledger: OutboundLedger = {
      lease: (id, req) => {
        leases += 1;
        return busy.has(id) ? Promise.reject(new Error('busy')) : r.ledger.lease(id, req);
      },
      mark: () => Promise.reject(new Error('the store is read-only')),
      read: (id) => r.ledger.read(id),
      statAllForRun: (id) => r.ledger.statAllForRun(id),
      deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
    };
    const pass = passOf(r, { ledger });
    await pass();
    // The pass goes on: each of the three questions asked for its lease.
    const firstPass = leases;
    await r.clock.set(at(30 * MIN));
    await pass();
    await r.clock.set(at(40 * MIN));
    await pass();
    const lease = r.logger.lines.warn.filter((l) => l.includes('refused a lease'));
    expect({
      firstPass,
      posts: slack.posts.length,
      mark: r.logger.lines.warn.filter((l) => !l.includes('refused a lease')),
      lease: lease.map((l) => l.replace(/run \S+ \(/, 'run <run> (')),
      leaseRun: [...busy].some((id) => lease[0]?.includes(id)),
    }).toEqual({
      firstPass: 3,
      posts: 1,
      mark: [
        `listen: reminders: reminder 1 of run ${q.runId} posted, could not be recorded: Error: the store is read-only`,
      ],
      lease: [
        'listen: reminders: the store refused a lease for run <run> (Error: busy); nothing sent for it',
      ],
      leaseRun: true,
    });
  });

  for (const [reason, words] of [
    ['outbound_done', 'had sent it: duplicate certain'],
    ['lease_lost', 'took its lease over meanwhile: duplicate possible'],
  ] as const) {
    it(`a mark answering \`${reason}\`: one line per row`, async () => {
      // (a) red when the duplicate is not said, or said twice; (b) prints the lines.
      const r = await rig();
      const q = await question(r);
      await r.clock.set(at(25 * MIN));
      const ledger: OutboundLedger = {
        lease: (id, req) => r.ledger.lease(id, req),
        mark: () => Promise.resolve({ applied: false, reason }),
        read: (id) => r.ledger.read(id),
        statAllForRun: (id) => r.ledger.statAllForRun(id),
        deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
      };
      const pass = passOf(r, { ledger });
      await pass();
      await r.clock.set(at(30 * MIN));
      await pass();
      expect(r.logger.lines.warn).toEqual([
        `listen: reminders: reminder 1 of run ${q.runId} posted, but another sender ${words}`,
      ]);
    });
  }
});

describe('#597 D3b — the runner', { timeout: 30_000 }, () => {
  it('one pass at a time; a wake during a pass makes exactly one more', async () => {
    // (a) red when two passes overlap, or a wake during a pass is lost or doubled; (b) prints counts.
    let running = 0;
    let most = 0;
    let passes = 0;
    let release: () => void = () => {};
    const runner = makePollRunner(
      async () => {
        running += 1;
        passes += 1;
        most = Math.max(most, running);
        await new Promise<void>((r) => (release = r));
        running -= 1;
        return false;
      },
      'reminders',
      capture(),
    );
    const first = runner.wake();
    void runner.wake();
    void runner.wake();
    release();
    await settle();
    release();
    await first;
    await settle();
    expect({ passes, most }).toEqual({ passes: 2, most: 1 });
  });

  it('the budget: after 45 s no new send starts; the next wake is at the pass’s end plus one second', async () => {
    // (a) red when a send starts past the budget, or the next pass is not a second after; (b) prints
    //     the posts and whether a one-second wake was set.
    const r = await rig();
    await question(r);
    await question(r);
    await r.clock.set(at(25 * MIN));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const clockNow = vi.spyOn(performance, 'now');
    clockNow.mockImplementationOnce(() => 0).mockImplementation(() => 45_000);
    const runner = makePollRunner(passOf(r), 'reminders', r.logger);
    await runner.wake();
    const cut = {
      posts: slack.posts.length,
      wake: timers.mock.calls.filter(([, ms]) => ms === 1000).length,
    };
    await runner.stop();
    clockNow.mockImplementation(() => 0);
    await passOf(r)();
    expect({ cut, within: slack.posts.length }).toEqual({ cut: { posts: 0, wake: 1 }, within: 2 });
  });

  it('`stop()` returns the running pass; no new lease after it', async () => {
    // (a) red when a lease starts after `stop()`, or `stop()` does not wait for the pass; (b) prints
    //     the leases and whether the stop waited.
    const r = await rig();
    await question(r);
    await question(r);
    await r.clock.set(at(25 * MIN));
    let leases = 0;
    let gate: () => void = () => {};
    const blocked = new Promise<void>((res) => (gate = res));
    const ledger: OutboundLedger = {
      lease: async (id, req) => {
        leases += 1;
        await blocked;
        return r.ledger.lease(id, req);
      },
      mark: (id, req) => r.ledger.mark(id, req),
      read: (id) => r.ledger.read(id),
      statAllForRun: (id) => r.ledger.statAllForRun(id),
      deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
    };
    const pass = makeReminderPass({
      runStore: r.store,
      outbound: ledger,
      home: r.h.path,
      workflows: new Map([[WF, workflow(WF)]]),
      logger: r.logger,
    });
    const runner = makePollRunner(pass, 'reminders', r.logger);
    void runner.wake();
    await settle();
    let waited = false;
    const stopping = runner.stop().then(() => (waited = true));
    await settle();
    const before = waited;
    gate();
    await stopping;
    expect({ leases, before, waited }).toEqual({ leases: 1, before: false, waited: true });
  });

  it('no new probe after the budget or after `stop()`: a paused workflow’s due `auth.test` is not called', async () => {
    // (a) red when a probe starts past the budget or once the runner has stopped; (b) prints the
    //     `auth.test` counts.
    const r = await rig();
    await question(r);
    await r.clock.set(at(25 * MIN));
    slack.post = refused('invalid_auth');
    slack.auth = refused('invalid_auth');
    // The budget runs out, or the runner stops, at the question's ledger read: after the pass's own
    // check before the question, before the probe.
    let at45 = false;
    let stopped = false;
    let flip: 'budget' | 'stop' | undefined;
    vi.spyOn(performance, 'now').mockImplementation(() => (at45 ? 45_000 : 0));
    const pass = makeReminderPass({
      runStore: r.store,
      outbound: {
        lease: (id, req) => r.ledger.lease(id, req),
        mark: (id, req) => r.ledger.mark(id, req),
        read: (id) => {
          if (flip === 'budget') at45 = true;
          if (flip === 'stop') stopped = true;
          return r.ledger.read(id);
        },
        statAllForRun: (id) => r.ledger.statAllForRun(id),
        deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
      },
      home: r.h.path,
      workflows: new Map([[WF, workflow(WF)]]),
      logger: r.logger,
    });
    await pass(() => true);
    await r.clock.set(at(27 * MIN));
    flip = 'budget';
    await pass(() => true);
    const afterBudget = slack.auths;
    at45 = false;
    flip = 'stop';
    await pass(() => !stopped);
    const afterStop = slack.auths;
    flip = undefined;
    await pass(() => true);
    expect({ afterBudget, afterStop, after: slack.auths }).toEqual({
      afterBudget: 0,
      afterStop: 0,
      after: 1,
    });
  });
});

/** `realm listen` started in this process on a free port, its signal listeners collected. */
async function listening(
  r: Rig,
  o: {
    sendReminders?: boolean;
    sweepMs?: number;
    graceSeconds?: number;
    port?: number;
    runStore?: ListenDeps['runStore'];
  } = {},
) {
  const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
  const routes = new Map<string, WorkflowEntry>([
    [
      '/hook',
      {
        path: '/hook',
        definition: def(WF),
        trigger: { type: 'webhook', path: '/hook', auth: { mode: 'none' } } as never,
        workflowDir: r.h.path,
        slackGate: {
          bot_token: 'xoxb-d3b-fake',
          channel_id: CHANNEL,
          reminder_interval_ms: 10 * MIN,
        },
      },
    ],
  ]);
  const deps: ListenDeps = {
    workflowStore: r.h.home.workflowStore,
    runStore: o.runStore ?? r.store,
    dedupStoreFor: () => ({
      check: async () => false,
      record: async () => {},
      cleanup: async () => {},
    }),
    spawnAgent: async () => ({ pid: 1 }),
    logger: r.logger,
    home: r.h.path,
  };
  let added: Array<(...a: unknown[]) => void> = [];
  try {
    const handle = await startListen(
      routes,
      {
        port: o.port ?? 0,
        host: '127.0.0.1',
        bodyTimeoutMs: 5000,
        maxBodyBytes: 1_048_576,
        maxConcurrent: 20,
        ...(o.sendReminders === false ? {} : { sendReminders: true }),
        ...(o.sweepMs !== undefined ? { sweepExpiredGatesIntervalMs: o.sweepMs } : {}),
        ...(o.graceSeconds !== undefined ? { shutdownGraceSeconds: o.graceSeconds } : {}),
      },
      deps,
    );
    onTestFinished(() => handle.shutdown('test'));
    return { handle, signal: () => added[0]!('SIGTERM') };
  } finally {
    added = process.listeners('SIGTERM').filter((l) => !before.term.includes(l)) as never;
    for (const l of added) process.removeListener('SIGTERM', l);
    for (const l of process.listeners('SIGINT'))
      if (!before.int.includes(l)) process.removeListener('SIGINT', l);
  }
}

/** The store seen through a proxy that counts its scans. */
function counted(store: RunStore): { runStore: RunStore; scans: () => number } {
  let scans = 0;
  const runStore = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'scan') {
        return (...a: Parameters<RunStore['scan']>) => {
          scans += 1;
          return target.scan(...a);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { runStore, scans: () => scans };
}

describe('#597 D3b — `realm listen` and the sender', { timeout: 30_000 }, () => {
  it('no flag: no scan, no 60-second timer, no Slack call, no line', async () => {
    // (a) red when anything runs without `--send-reminders`; (b) prints the counts and lines.
    const r = await rig();
    await question(r);
    await r.clock.set(at(25 * MIN));
    const { runStore, scans } = counted(r.store);
    const timers = vi.spyOn(globalThis, 'setInterval');
    await listening(r, { sendReminders: false, runStore });
    await settle();
    expect({
      scans: scans(),
      timer: timers.mock.calls.some(([, ms]) => ms === REMINDER_POLL_MS),
      posts: slack.posts.length,
      lines: r.logger.lines.info.filter((l) => l.includes('reminders')),
    }).toEqual({ scans: 0, timer: false, posts: 0, lines: [] });
  });

  it('a failed bind: no scan, no Slack call, no timer; a bind that works: the first pass once listening, then the 60-second timer', async () => {
    // (a) red when the first pass runs before the server listens; (b) prints the counts.
    const r = await rig();
    await question(r);
    await r.clock.set(at(25 * MIN));
    const blocker: Server = createServer();
    await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res));
    onTestFinished(() => new Promise<void>((res) => blocker.close(() => res())));
    const port = (blocker.address() as { port: number }).port;
    const { runStore, scans } = counted(r.store);
    const timers = vi.spyOn(globalThis, 'setInterval');
    const failed = await listening(r, { port, runStore }).then(
      () => 'bound',
      () => 'refused',
    );
    await settle();
    const afterFail = {
      failed,
      scans: scans(),
      posts: slack.posts.length,
      timer: timers.mock.calls.some(([, ms]) => ms === REMINDER_POLL_MS),
    };
    await listening(r, { runStore });
    await settle();
    expect({
      afterFail,
      scans: scans(),
      posts: slack.posts.length,
      timer: timers.mock.calls.some(([, ms]) => ms === REMINDER_POLL_MS),
    }).toEqual({
      afterFail: { failed: 'refused', scans: 0, posts: 0, timer: false },
      scans: 1,
      posts: 1,
      timer: true,
    });
  });

  it('separate loops: a Slack outage (every post times out) does not delay an expiry the sweeper carries out', async () => {
    // (a) red when the sender runs inside the sweeper's pass (the expiry waits for the post); (b)
    //     prints the run's phase and how long the enactment took.
    const r = await rig();
    await question(r);
    const expiring = await question(
      r,
      { expires_at: at(26 * MIN).toISOString(), on_expiry: 'abort' },
      { file: 'none' },
    );
    await r.clock.set(at(25 * MIN));
    let release: () => void = () => {};
    slack.post = () =>
      new Promise<Response>((res) => (release = () => res(new Response('{"ok":true}'))));
    const timers = vi.spyOn(globalThis, 'setInterval');
    await listening(r, { sweepMs: 30_000 });
    await settle();
    // The sweeper's first pass (its period is not waited for): it reads the gate and arms its waiter.
    const sweep = timers.mock.calls.find(([, ms]) => ms === 30_000)?.[0] as () => void;
    sweep();
    await settle();
    const started = Date.now();
    await r.clock.set(at(27 * MIN));
    for (
      let i = 0;
      i < 50 && (await r.store.get(expiring.runId)).record.run_phase === 'gate_waiting';
      i += 1
    )
      await settle();
    const phase = (await r.store.get(expiring.runId)).record.run_phase;
    release();
    expect({ phase, fast: Date.now() - started < 1000 }).toEqual({ phase: 'aborted', fast: true });
  });

  it('shutdown: the wait for a pass under way ends with the grace, at once with `--shutdown-grace 0` and on a second signal', async () => {
    // (a) red when the stop waits for the pass beyond the grace (the wait doubles); (b) prints how
    //     long each stop took.
    const took: Record<string, number> = {};
    for (const [label, grace, second] of [
      ['grace 1', 1, false],
      ['grace 0', 0, false],
      ['second signal', 600, true],
    ] as const) {
      const r = await rig();
      await question(r);
      await r.clock.set(at(25 * MIN));
      slack.post = () => new Promise<Response>(() => {});
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const { handle, signal } = await listening(r, { graceSeconds: grace });
      await settle();
      const started = Date.now();
      const stopped = handle.shutdown('test');
      if (second) {
        signal();
        signal();
      }
      await stopped;
      took[label] = Math.round((Date.now() - started) / 500) * 500;
    }
    expect(took).toEqual({ 'grace 1': 1000, 'grace 0': 0, 'second signal': 0 });
  });
});

describe('#597 D3b — the start-up lines', { timeout: 30_000 }, () => {
  it('the covered list, none covered, no ledger, no home: each one line, and no runner without coverage', async () => {
    // (a) red when an uncovered workflow is listed, or a runner starts without a ledger, a home or a
    //     covered workflow; (b) prints the lines.
    const r = await rig();
    const logger = capture();
    const sources = [
      { definition: def(WF), slackGate: { bot_token: 'x', channel_id: CHANNEL } },
      { definition: def(WF2), slackGate: { bot_token: 'x' } },
      { definition: def('d3b-c') },
    ];
    const runners = [
      reminderSenderOf(sources, { runStore: r.store, home: r.h.path, logger }),
      reminderSenderOf(sources.slice(1), { runStore: r.store, home: r.h.path, logger }),
      reminderSenderOf(sources, {
        runStore: { ...r.store, outbound: null } as never,
        home: r.h.path,
        logger,
      }),
      reminderSenderOf(sources, { runStore: r.store, home: undefined, logger }),
    ];
    expect({ runners: runners.map((x) => x !== undefined), lines: logger.lines }).toEqual({
      runners: [true, false, false, false],
      lines: {
        info: [
          `listen: reminders: covering workflows ${WF}`,
          'listen: reminders: no mounted workflow has a Slack bot token and channel; nothing to remind',
        ],
        warn: [
          'listen: reminders: the store keeps no outbound ledger; not sent',
          'listen: reminders: no home folder known; not sent',
        ],
        error: [],
      },
    });
  });

  it('a pass that throws: ONE error line, and the loop goes on', async () => {
    // (a) red when a throwing pass stops the runner or logs nothing; (b) prints the lines and passes.
    const logger = capture();
    let passes = 0;
    const runner = makePollRunner(
      async () => {
        passes += 1;
        if (passes === 1) throw new Error('scan failed');
        return false;
      },
      'reminders',
      logger,
    );
    await runner.wake();
    await runner.wake();
    expect({ passes, error: logger.lines.error }).toEqual({
      passes: 2,
      error: ['listen: reminders: pass failed {"error":"Error: scan failed"}'],
    });
  });

  it('the defaults: no `reminder_interval_ms` and no `escalation_threshold_ms` ⇒ the reminder at 10 minutes and the nudge at 30, as `realm agent`', async () => {
    // (a) red when the sender's defaults differ from the agent's; (b) prints the posts per minute.
    const r = await rig();
    await question(r);
    const runner = reminderSenderOf(
      [{ definition: def(WF), slackGate: { bot_token: 'xoxb-d3b-fake', channel_id: CHANNEL } }],
      { runStore: r.store, home: r.h.path, logger: r.logger },
    )!;
    const posted: Record<string, number> = {};
    for (const m of [9, 10, 29, 30]) {
      await r.clock.set(at(m * MIN));
      const before = slack.posts.length;
      await runner.wake();
      posted[`${m}m`] = slack.posts.length - before;
    }
    await runner.stop();
    expect(posted).toEqual({ '9m': 0, '10m': 1, '29m': 0, '30m': 1 });
  });

  it("one question's failure: ONE error line naming its run, and the pass goes on to the next question", async () => {
    // (a) red when one question's throw ends the pass or is not logged with its run; (b) prints the
    //     posts and the error lines.
    const r = await rig();
    const bad = await question(r);
    const good = await question(r);
    await r.clock.set(at(25 * MIN));
    const ledger: OutboundLedger = {
      lease: (id, req) => r.ledger.lease(id, req),
      mark: (id, req) => r.ledger.mark(id, req),
      read: async (id) => {
        if (id === bad.runId) throw new Error('read failed');
        return r.ledger.read(id);
      },
      statAllForRun: (id) => r.ledger.statAllForRun(id),
      deleteAllForRun: (id) => r.ledger.deleteAllForRun(id),
    };
    await passOf(r, { ledger })();
    expect({
      posts: slack.posts.map((p) => p.text.includes(good.runId)),
      error: r.logger.lines.error,
    }).toEqual({
      posts: [true],
      error: [
        `listen: reminders: pass failed {"run_id":"${bad.runId}","error":"Error: read failed"}`,
      ],
    });
  });
});

describe('#597 D3b — the words', { timeout: 30_000 }, () => {
  const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  const claim = (page: string, sentence: string): void =>
    expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));

  it('realm-listen.md, slack-gates.md, gates.md, deployment-manifest.md and the CHANGELOG say what the flag does, each claim executed above', () => {
    // "every 60 seconds, the first time when it starts listening": "a failed bind …" (the first pass
    // once listening, the 60-second timer); "for each question whose realm agent has stopped": "the
    // five post files"; "counted from when the question was posted, once, with the time the question
    // has really been open": the texts' ages ("25m", "40m"); "mounted with a notifiers.slack_gate
    // that has a bot_token and a channel_id": the start-up lines and "a workflow that is not
    // covered"; "another machine … gets no reminders": "the five post files"; "never the reminder
    // that says the time ran out of a question that closes at its limit": "never the final …"; the
    // sentence and the command: the literal texts; "never both post": "exactly once"; "a restart …
    // can post that one again" and "the first start after an upgrade can post one reminder to each
    // such question": INFERRED (D1 R1, R13), not executed here; "--sweep-expired-gates is separate":
    // "separate loops"; the pause, the probes and "resumes when a reminder is taken": "the probes",
    // "`not_in_channel`"; "A new token needs a restart": the settings are captured at start
    // (`reminderSenderOf`), not executed here; "up to 8 tries in all": "attempts 8"; the stop: "shutdown".
    claim(
      'docs/reference/cli/realm-listen.md',
      "A Slack question's reminder and escalation are posted by the `realm agent` that posted the question; when that agent stops, they stop. With this flag, `realm listen` posts them instead. Every 60 seconds, the first time when it starts listening, it reads the runs in the store that are waiting at a question.",
    );
    claim(
      'docs/reference/cli/realm-listen.md',
      '`realm listen` does not read replies in the thread, so each reminder it posts says `Realm is not reading replies in this thread right now — to respond, open a terminal and run:` and gives the `realm run respond` command.',
    );
    // The rest of the section, each sentence executed by the cell named beside it.
    for (const sentence of [
      // "the five post files" (stopped / running), the texts' ages, "only the grid's due item".
      "For each question whose `realm agent` has stopped, it posts the reminder or the escalation that has come due, in the question's own thread, as the agent would have: counted from when the question was posted, once, with the time the question has really been open.",
      // the start-up lines; "a workflow that is not covered"; "the five post files".
      "It covers a question only when its workflow is mounted with a `notifiers.slack_gate` that has a `bot_token` and a `channel_id`, which it posts with, and the stopped agent's question post file is on this machine",
      // "the five post files" (another host: one line, nothing posted; no file: silent).
      'A question posted from another machine, or by an agent that stopped before it wrote that file, gets no reminders from it.',
      // "never the final of an `on_expiry` gate".
      'It never posts the reminder that says the time ran out of a question that closes at its limit (`on_expiry`).',
      // "exactly once" (both cells).
      "It records each reminder in the store's outbound ledger, as the agents do, so an agent that comes back and `realm listen` never both post the same one.",
      // INFERRED (D1 R1, R13): not executed here.
      'A restart while a reminder is being posted can post that one again, and the first start after an upgrade can post one reminder to each such question.',
      // "cools THAT workflow only" (timeout, ratelimited, the auth class, HTTP 503); "`not_in_channel`".
      "When Slack does not take a post because of a problem with the whole workflow (an outage, a rate limit, a revoked token, a bot removed from the channel), that workflow's reminders pause.",
      // "the probes".
      '`realm listen` checks Slack again after 1, 2, 4 … up to 30 minutes and resumes when a reminder is taken.',
      // The settings are read once at start (`reminderSenderOf`): not executed here.
      'A new token needs a restart of `realm listen`.',
      // "attempts 1, 2, 7" and "attempts 8"; "isolation".
      'Any other post Slack does not take is tried again later, each time a little later, up to 8 tries in all.',
      // The log row of `pass failed`: "a pass that throws" and "one question's failure".
      "A `--send-reminders` pass failed, or one question's part of it (the line then names `run_id` too); the next pass tries again.",
      // The table row; the built CLI cell; "a failed bind …" (the 60-second timer).
      "Every 60 seconds, posts the due Slack reminder or escalation of each waiting question whose `realm agent` has stopped, in the question's own thread. See below. Added after version 0.49.0.",
    ])
      claim('docs/reference/cli/realm-listen.md', sentence);
    // The log table: exactly the sender's lines, each one asserted where it is printed above.
    const logRows = read('docs/reference/cli/realm-listen.md')
      .split('\n')
      .filter((l) => l.startsWith('| `') && l.includes('`listen: reminders: '))
      .map((l) => /`(listen: reminders: [^`]*)`/.exec(l)![1]);
    expect(logRows).toEqual([
      'listen: reminders: covering workflows <ids>',
      'listen: reminders: no mounted workflow has a Slack bot token and channel; nothing to remind',
      'listen: reminders: the store keeps no outbound ledger; not sent',
      'listen: reminders: no home folder known; not sent',
      'listen: reminders: no usable post for run <run>, question <gate>: not reminded',
      'listen: reminders: Slack did not take a reminder for workflow <id> (<code>): reminders for it wait; checking again in about <n> min',
      'listen: reminders: Slack took a reminder for workflow <id> again: reminders for it resume',
      'listen: reminders: Slack refused <what> of run <run> (<code>): tried again later',
      'listen: reminders: <what> of run <run> not confirmed after 8 tries; not tried again',
      'listen: reminders: the store refused a lease for run <run> (<error>); nothing sent for it',
      'listen: reminders: <what> of run <run> posted, could not be recorded: <error>',
      'listen: reminders: <what> of run <run> posted, but another sender had sent it: duplicate certain',
      'listen: reminders: pass failed {"error"}',
    ]);
    claim(
      'docs/reference/cli/realm-listen.md',
      '`--sweep-expired-gates` is separate and is not needed. Without it, the reminders of a question that closes at its time limit stop at that limit, and the question stays open until something carries it out.',
    );
    claim(
      'docs/reference/cli/realm-listen.md',
      'With `--send-reminders`, no new reminder starts after the first Ctrl+C or `SIGTERM`; one being posted gets the same grace, and a second Ctrl+C or `SIGTERM` ends the wait at once (added after version 0.49.0).',
    );
    claim(
      'docs/guides/slack-gates.md',
      "If that process stops, the reminders stop, unless `realm listen --send-reminders` runs on the same machine with the workflow mounted: it then posts them in the question's thread, saying that Realm is not reading replies there",
    );
    claim(
      'docs/reference/workflow/gates.md',
      'Reminders are sent by the process that is waiting at the gate with a Slack connection, or, once that process has stopped, by `realm listen --send-reminders` (added after version 0.49.0).',
    );
    claim(
      'docs/reference/deployment-manifest.md',
      '`realm listen --send-reminders` reads `bot_token`, `channel_id`, `reminder_interval_ms` and `escalation_threshold_ms` (added after version 0.49.0).',
    );
    const changelog = read('CHANGELOG.md');
    expect(
      flat(
        changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('\n## [0.49.0]')),
      ),
    ).toContain(
      flat(
        "- **`realm listen --send-reminders`** (issue #597): every 60 seconds, `realm listen` posts the due Slack reminder or escalation of each waiting question whose `realm agent` has stopped, into the question's own thread, through the store's outbound ledger, so it and an agent that comes back never both post it. A post Slack does not take because of a Slack-wide problem pauses that workflow's reminders, and `realm listen` checks Slack again after 1, 2, 4 … up to 30 minutes.",
      ),
    );
  });

  it('the help: `--send-reminders` says what it does; `--sweep-expired-gates` no longer says listen never touches gates', () => {
    // (a) red when either help text changes; (b) prints both. "only posts reminders": "never the final
    //     …" (the questions past their limit still wait); the rest: as the realm-listen.md section.
    const help = (long: string): string | undefined =>
      listenCommand.options.find((o) => o.long === long)?.description;
    expect({ send: help('--send-reminders'), sweep: help('--sweep-expired-gates') }).toEqual({
      send: "OPT-IN (issue #597): every 60 seconds, post the due Slack reminder or escalation of each waiting question whose realm agent has stopped, into the question's own thread, with the bot token and channel the workflow's notifiers.slack_gate carries. Default OFF.",
      sweep:
        'OPT-IN (issue #291): store-wide sweep interval, a whole number of seconds from 1 to 2147483, that enacts expired, enactable gates across every run this store holds. Default OFF — listen carries out no expired gate unless this is set (--send-reminders only posts reminders). Never drains finalizers itself — see: realm run drain --expired.',
    });
  });
});

describe('#597 D3b — the built CLI', { timeout: 90_000 }, () => {
  it('`--send-reminders` reaches the sender with the home folder and the workflow’s Slack settings; without it, no reminders line', async () => {
    // (a) red when the command line drops the flag, the home folder or the workflow's
    //     `notifiers.slack_gate` (each prints another line, or none); (b) prints both runs' lines.
    const CLI = join(ROOT, 'packages/cli/dist/index.js');
    const root = mkdtempSync(join(tmpdir(), 'realm-d3b-cli-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const wf = join(root, 'wf');
    mkdirSync(home);
    mkdirSync(wf);
    writeFileSync(
      join(wf, 'workflow.yaml'),
      'id: d3b-cli\nname: d3b cli\nversion: 1\ntrigger:\n  type: webhook\n  path: /hook-d3b\n  auth:\n    mode: none\nsteps:\n  ask:\n    description: Answer.\n    execution: agent\n',
    );
    writeFileSync(
      join(wf, 'realm.yaml'),
      [
        'version: 1',
        'notifiers:',
        '  slack_gate:',
        '    type: slack',
        '    config:',
        '      bot_token: "${secret:SLACK_BOT}"',
        `      channel_id: ${CHANNEL}`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(wf, '.env'), 'SLACK_BOT=xoxb-fake-d3b\n');
    const reminderLines = async (extra: string[]): Promise<string[]> => {
      const proc = spawn(
        process.execPath,
        [CLI, 'listen', '.', '--model', 'm', '--provider', 'anthropic', '--port', '0', ...extra],
        {
          cwd: wf,
          env: { PATH: process.env['PATH'] ?? '', HOME: home, ANTHROPIC_API_KEY: 'k-fake-d3b' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      onTestFinished(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      });
      let text = '';
      proc.stdout!.on('data', (d: Buffer) => (text += d.toString()));
      proc.stderr!.on('data', (d: Buffer) => (text += d.toString()));
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      const by = performance.now() + 30_000;
      while (!/realm listen on /.test(text) && proc.exitCode === null && performance.now() < by) {
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!/realm listen on /.test(text))
        throw new Error(`listen did not start: ${text.slice(0, 600)}`);
      proc.kill('SIGTERM');
      await exited;
      return text.split('\n').filter((l) => l.startsWith('listen: reminders:'));
    };
    expect({ on: await reminderLines(['--send-reminders']), off: await reminderLines([]) }).toEqual(
      {
        on: ['listen: reminders: covering workflows d3b-cli'],
        off: [],
      },
    );
  });
});
