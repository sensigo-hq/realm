// slack-question-post-729-pr6b.test.ts — #729 PR-6b: Realm's Slack question post says when the
// question closed, and a `realm agent` restarted while it is open uses the same post. Acceptance
// checks 1–15, against the test copy of Slack the suite already uses (a stubbed `fetch`; a thread
// reply reaches the notifier through the captured event callback), a real store and the real engine.
// Check 9's first agent is a real `realm agent` process with Slack stubbed, killed once its file is
// written.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  executeStep,
  instantText,
  loadWorkflowFromString,
  submitHumanResponse,
  type PendingGate,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createSlackGateHandler } from './slack-gate-notifier.js';
import { startSlackGateServer, type SlackGateEvent } from './slack-gate-server.js';
import { slackPostPath, takeOverSlackPostFile, readSlackPostFile } from './slack-post-file.js';
import { slackResponse } from '../test-support/slack-response.js';
import { makeTempHome, type TempHome } from '../../test-support/temp-home.js';

vi.mock('./slack-gate-server.js', () => ({
  startSlackGateServer: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock('./slack-socket-client.js', () => ({
  connectSocketMode: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const CLI_ENTRY = join(HERE, '../../../dist/index.js');
const LLM_PROVIDER = join(HERE, '../../../dist/agent/providers/llm-provider.js');

const TOKEN = 'xoxb-pr6b-fake-token';
const SIGNING = 'pr6b-fake-signing-secret';
const CHANNEL = 'C123';
/** The `ts` Slack gives this agent's question post. */
const POST_TS = '1700000000.000100';
/** The `ts` of a post an earlier agent made. */
const OLD_TS = '1600000000.000900';

/** `confirm` (a question; a time limit with `on_expiry` when given), then `after` (`auto`). */
function gated(id: string, onExpiry?: 'settle_default'): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          ...(onExpiry !== undefined
            ? { timeout_seconds: 3600, on_expiry: onExpiry, default_choice: 'approve' }
            : {}),
        },
      },
      after: { description: 'After', execution: 'agent', depends_on: ['confirm'] },
    },
  };
}

/** `confirm` beside a sibling `aborter` that ends the run while the question is open. */
function withAborter(id: string): WorkflowDefinition {
  const def = gated(id);
  return {
    ...def,
    steps: {
      ...def.steps,
      aborter: { description: 'Aborts.', execution: 'auto', handler: 'abort-handler' },
    },
  } as WorkflowDefinition;
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

interface Body {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  blocks?: Array<{ text?: { text?: string } }>;
}

describe('#729 PR-6b — the Slack question post', () => {
  let h: TempHome & { readonly root: string };
  let store: RunStore;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let lines: string[];
  let onEvent: ((event: SlackGateEvent) => void) | undefined;

  /** Slack's test copy: a question post gets `POST_TS`; an edit answers as `update` says. */
  function stubSlack(update: 'ok' | 'refused' | 'never' = 'ok'): void {
    fetchSpy = vi.fn((url: unknown) => {
      if (String(url).includes('chat.update')) {
        if (update === 'never') return new Promise<Response>(() => {});
        return Promise.resolve(
          slackResponse({
            json: update === 'ok' ? { ok: true } : { ok: false, error: 'message_not_found' },
          }),
        );
      }
      return Promise.resolve(slackResponse({ json: { ok: true, ts: POST_TS } }));
    });
    vi.stubGlobal('fetch', fetchSpy);
  }

  beforeEach(async () => {
    h = await makeTempHome();
    store = h.home.runStore;
    stubSlack();
    lines = [];
    onEvent = undefined;
    for (const kind of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(a.join(' '));
      });
    }
    vi.mocked(startSlackGateServer).mockImplementation((o) => {
      onEvent = o.onEvent;
      return { close: vi.fn() };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await h.cleanup();
  });

  const bodies = (method: 'chat.postMessage' | 'chat.update'): Body[] =>
    fetchSpy.mock.calls
      .filter(([url]) => String(url).includes(method))
      .map(([, init]) => JSON.parse((init as { body: string }).body) as Body);
  /** The question posts (the thread's replies carry `thread_ts`). */
  const questionPosts = (): Body[] => bodies('chat.postMessage').filter((b) => b.blocks);
  const threadPosts = (): string[] =>
    bodies('chat.postMessage')
      .filter((b) => b.thread_ts !== undefined)
      .map((b) => b.text!);
  const shown = (): string =>
    `Slack calls: ${JSON.stringify(
      fetchSpy.mock.calls.map(([url, init]) => [
        String(url),
        JSON.parse((init as { body: string }).body) as unknown,
      ]),
      null,
      2,
    )}\nprinted: ${JSON.stringify(lines, null, 2)}`;

  async function openQuestion(
    def: WorkflowDefinition,
    before?: (runId: string) => Promise<void>,
  ): Promise<{ runId: string; gate: PendingGate }> {
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await before?.(run.id);
    const opened = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    return { runId: run.id, gate: (await store.get(run.id)).record.pending_gate! };
  }

  /** Alice's answer from a terminal, as `realm run respond --by alice` sends it; its time. */
  async function terminalAnswer(
    def: WorkflowDefinition,
    runId: string,
    gate: PendingGate,
  ): Promise<string> {
    const r = await submitHumanResponse(store, def, {
      runId,
      gateId: gate.gate_id,
      choice: 'approve',
      respondedBy: 'alice',
      route: 'cli',
      caller: 'respond',
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${r.status}`);
    return answerTime(runId);
  }

  async function answerTime(runId: string): Promise<string> {
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.kind === 'gate_response');
    return instantText(Date.parse(entry!.completed_at));
  }

  /** The handler `realm agent` builds: a bot token and channel (a listener unless `listen` is
   *  false), or a webhook; the temp home. */
  function handler(
    def: WorkflowDefinition,
    o: { listen?: boolean; webhook?: boolean; store?: RunStore } = {},
  ): (runId: string, gate: PendingGate) => Promise<void> {
    return createSlackGateHandler({
      store: o.store ?? store,
      definition: def,
      provider: {} as never,
      ...(o.webhook === true
        ? { webhookUrl: 'https://hooks.slack.test/pr6b' }
        : { botToken: TOKEN, channelId: CHANNEL }),
      ...(o.webhook !== true && o.listen !== false ? { signingSecret: SIGNING } : {}),
      pollIntervalMs: 0,
      home: h.path,
    });
  }

  /** A file under the home naming a writer that is not this process. */
  function seedFile(
    runId: string,
    gate: PendingGate,
    record: { channel: string; ts: string; pid: number },
  ): { path: string; bytes: string } {
    const path = slackPostPath(h.path, runId, gate.gate_id);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = `${JSON.stringify({ ...record, host: hostname(), id: 'an-earlier-process' })}\n`;
    writeFileSync(path, bytes);
    return { path, bytes };
  }

  /** A pid that ran and has exited. */
  function deadPid(): number {
    const pid = spawnSync(process.execPath, ['-e', '']).pid;
    if (pid === undefined) throw new Error('fixture: no pid');
    return pid;
  }

  /** The file's fields, or `undefined` when it is not there or is not JSON. */
  const fileIn = (path: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  it('check 1: answered from a terminal, a listener set — one edit to the question post: its route block becomes the closing line; the file is gone', async () => {
    const def = gated('pr6b-1');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    const run = handler(def)(runId, gate);
    await until(() => existsSync(file));
    const during = existsSync(file);
    const at = await terminalAnswer(def, runId, gate);
    await run;
    const posted = questionPosts()[0]!;
    const line = `This question is closed: it was answered — approve, by "alice" (as stated), from a terminal, at ${at}.`;
    // (a) red when the post is not edited at close, its blocks or text differ, or the file stays;
    //     (b) prints every Slack call and every printed line.
    expect(
      {
        during,
        route: posted.blocks![2]!.text!.text!.split('\n')[0],
        updates: bodies('chat.update'),
        after: existsSync(file),
      },
      shown(),
    ).toEqual({
      during: true,
      route: 'Reply in this thread with `approve` or `reject`, or from a terminal:',
      updates: [
        {
          channel: CHANNEL,
          ts: POST_TS,
          text: line,
          blocks: [posted.blocks![0], posted.blocks![1], section(line), ...posted.blocks!.slice(3)],
        },
      ],
      after: false,
    });
  });

  it('check 2: answered in the thread — the `✅` reply, and the edit names the answer from a Slack thread with no `by` part', async () => {
    const def = gated('pr6b-2');
    const { runId, gate } = await openQuestion(def);
    const run = handler(def)(runId, gate);
    await until(() => onEvent !== undefined && questionPosts().length > 0);
    onEvent!({ event_id: 'E1', thread_ts: POST_TS, user: 'U1', text: 'approve', ts: '1.1' });
    await run;
    const at = await answerTime(runId);
    // (a) red when the edit is skipped because a Slack answer told the thread, or names a `by`;
    //     (b) prints every Slack call and every printed line.
    expect(
      { thread: threadPosts(), edits: bodies('chat.update').map((b) => b.text) },
      shown(),
    ).toEqual({
      thread: ['✅ Gate resolved: `approve` — run continuing.'],
      edits: [`This question is closed: it was answered — approve, in a Slack thread, at ${at}.`],
    });
  });

  it('check 3: its time ran out (the handler’s expiry timer), and the run stopped (a sibling step aborts) — each edit says how', async () => {
    // Its time ran out: the time limit is moved into the past, so the handler's own timer carries
    // the expiry out at once.
    const expiring = gated('pr6b-3a', 'settle_default');
    const first = await openQuestion(expiring);
    const { record } = await store.get(first.runId);
    const { record: moved } = await store.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: '2020-01-01T01:00:00.000Z' },
    });
    await handler(expiring)(first.runId, moved.pending_gate!);
    const timedOut = bodies('chat.update').map((b) => b.text);
    // The run stopped: a sibling step, claimed before the question opened, settles with an abort.
    stubSlack();
    const aborting = withAborter('pr6b-3b');
    let token: string | undefined;
    const second = await openQuestion(aborting, async (runId) => {
      token = (await store.claimStep(runId, 'aborter', aborting)).record.claims?.['aborter']?.token;
    });
    const run = handler(aborting)(second.runId, second.gate);
    await until(() => questionPosts().length > 0);
    await store.settleStep(
      second.runId,
      {
        kind: 'settle_step',
        step: 'aborter',
        outcome: 'abort',
        ...(token !== undefined ? { claimToken: token } : {}),
        evidence: [],
        abort: { stepId: 'aborter', abortMessage: 'aborter says stop' },
      },
      aborting,
    );
    await run;
    const stopped = bodies('chat.update').map((b) => b.text);
    // (a) red when only an answered question's post is edited; (b) prints the edits and the last
    //     cell's Slack calls.
    expect({ timedOut, stopped }, shown()).toEqual({
      timedOut: ['This question is closed: its time ran out.'],
      stopped: ['This question is closed: the run stopped.'],
    });
  }, 20_000);

  it('check 4: no listener, answered from a terminal — the edit replaces the `*Gate requires a terminal response …*` block', async () => {
    const def = gated('pr6b-4');
    const { runId, gate } = await openQuestion(def);
    const run = handler(def, { listen: false })(runId, gate);
    await until(() => questionPosts().length > 0);
    const at = await terminalAnswer(def, runId, gate);
    await run;
    const posted = questionPosts()[0]!;
    const line = `This question is closed: it was answered — approve, by "alice" (as stated), from a terminal, at ${at}.`;
    // (a) red when the post is edited only while a listener attends; (b) prints every Slack call
    //     and every printed line.
    expect(
      {
        route: posted.blocks![2]!.text!.text!.split('\n')[0],
        edited: bodies('chat.update').map((b) => b.blocks),
      },
      shown(),
    ).toEqual({
      route: '*Gate requires a terminal response — open a terminal and run:*',
      edited: [[posted.blocks![0], posted.blocks![1], section(line), ...posted.blocks!.slice(3)]],
    });
  });

  it('check 5: the edit refused (`message_not_found`) — exactly one line (a), no second edit, the file gone', async () => {
    stubSlack('refused');
    const def = gated('pr6b-5');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    const run = handler(def)(runId, gate);
    await until(() => existsSync(file));
    await terminalAnswer(def, runId, gate);
    await run;
    // (a) red when the refusal prints no line, or the edit is sent again; (b) prints every Slack
    //     call and every printed line.
    expect(
      {
        warned: lines.filter((l) => l.includes('Slack question post not updated')),
        edits: bodies('chat.update').length,
        file: existsSync(file),
      },
      shown(),
    ).toEqual({
      warned: [
        '  ⚠  Slack question post not updated to say the question closed — Slack refused the post: message_not_found',
      ],
      edits: 1,
      file: false,
    });
  });

  it('check 6: the edit never answered — exactly line (b), no thread-post line, the file gone, the handler back within about 2 s', async () => {
    stubSlack('never');
    const def = gated('pr6b-6');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    const run = handler(def)(runId, gate);
    await until(() => existsSync(file));
    await terminalAnswer(def, runId, gate);
    const closedAt = Date.now();
    await run;
    const tookMs = Date.now() - closedAt;
    // (a) red when the drain's thread line is printed for the edit, (b) is missing or printed
    //     twice, the file stays, or the handler waits past the bound; (b) prints every printed line.
    expect(
      {
        warned: lines.filter((l) => l.includes('⚠')),
        file: existsSync(file),
        within: tookMs < 4_000,
      },
      `${shown()}\nthe handler took ${tookMs} ms`,
    ).toEqual({
      warned: ['  ⚠  Slack question post not updated within 2 s; the question is closed'],
      file: false,
      within: true,
    });
  }, 20_000);

  it('check 7: the store read fails during the wait — no edit; the file still names this agent', async () => {
    const def = gated('pr6b-7');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    let failing = false;
    const failingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get' && failing) {
          return async () => {
            throw new Error('the store could not be read');
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const run = handler(def, { store: failingStore })(runId, gate);
    await until(() => existsSync(file));
    failing = true;
    const thrown = await run.then(
      () => undefined,
      (err: unknown) => (err as Error).message,
    );
    const left = fileIn(file);
    // (a) red when the edit and the delete run in a `finally` (the post edited, the file gone);
    //     (b) prints the file, every Slack call and every printed line.
    expect(
      {
        thrown,
        edits: bodies('chat.update').length,
        file:
          left === undefined ? 'gone' : { pid: left['pid'], host: left['host'], ts: left['ts'] },
      },
      shown(),
    ).toEqual({
      thrown: 'the store could not be read',
      edits: 0,
      file: { pid: process.pid, host: hostname(), ts: POST_TS },
    });
  });

  it('check 7b (A.7): the record cannot be read at close — no edit; line (a) gives the read’s error; the file is deleted', async () => {
    const def = gated('pr6b-7b');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    // The read that shows the question closed ends the wait; every read after it fails.
    let closed = false;
    const closingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            if (closed) throw new Error('the store could not be read at close');
            const snapshot = await target.get(id);
            if (snapshot.record.pending_gate === undefined) closed = true;
            return snapshot;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const run = handler(def, { store: closingStore })(runId, gate);
    await until(() => existsSync(file));
    await terminalAnswer(def, runId, gate);
    await run;
    // (a) red when the read's error prints no line, the post is edited anyway, or the file stays;
    //     (b) prints every Slack call and every printed line.
    expect(
      {
        warned: lines.filter((l) => l.includes('Slack question post not updated')),
        edits: bodies('chat.update').length,
        file: existsSync(file),
      },
      shown(),
    ).toEqual({
      warned: [
        '  ⚠  Slack question post not updated to say the question closed — the store could not be read at close',
      ],
      edits: 0,
      file: false,
    });
  });

  it('check 8: webhook only — no edit, nothing under `slack-posts/`, the channel’s closing post as today', async () => {
    fetchSpy = vi.fn().mockResolvedValue(slackResponse({ text: 'ok' }));
    vi.stubGlobal('fetch', fetchSpy);
    const def = gated('pr6b-8');
    const { runId, gate } = await openQuestion(def);
    const run = handler(def, { webhook: true })(runId, gate);
    await until(() => fetchSpy.mock.calls.length > 0);
    const at = await terminalAnswer(def, runId, gate);
    await run;
    // (a) red when an edit is attempted or a file is written for a webhook post; (b) prints every
    //     Slack call and every printed line.
    expect(
      {
        urls: fetchSpy.mock.calls.map(([url]) => String(url)),
        closing: (JSON.parse((fetchSpy.mock.calls[1]![1] as { body: string }).body) as Body).text,
        folder: existsSync(join(h.path, 'slack-posts')),
      },
      shown(),
    ).toEqual({
      urls: ['https://hooks.slack.test/pr6b', 'https://hooks.slack.test/pr6b'],
      closing: `This question (gate \`confirm\`, run ${runId}) is closed: it was answered — approve, by "alice" (as stated), from a terminal, at ${at}.`,
      folder: false,
    });
  });

  it('check 9: a restart — the first `realm agent` (a separate process) is killed once its file is written; a second agent posts nothing new, says so, takes a reply in the old thread, edits the old post, and deletes the file', async () => {
    const project = join(h.root, 'project');
    mkdirSync(project);
    writeFileSync(
      join(project, 'realm.yaml'),
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
    writeFileSync(join(project, '.env'), `SLACK_BOT=${TOKEN}\n`);
    const yaml = [
      'id: pr6b-restart',
      'name: pr6b-restart',
      'version: 1',
      'steps:',
      '  confirm:',
      '    description: Confirm.',
      '    execution: agent',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [approve, reject]',
      '',
    ].join('\n');
    writeFileSync(join(project, 'workflow.yaml'), yaml);
    writeFileSync(
      join(project, 'p.mjs'),
      `import { LlmProvider } from ${JSON.stringify(pathToFileURL(LLM_PROVIDER).href)};\n` +
        'export default new (class extends LlmProvider { async callStep() { return { ok: "yes" }; } })();\n',
    );
    // Slack's test copy for the first agent: every call is taken, and a question post gets OLD_TS.
    writeFileSync(
      join(project, 'slack.mjs'),
      `globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ts: ${JSON.stringify(OLD_TS)} }), { status: 200, headers: { 'content-type': 'application/json' } });\n`,
    );
    const first = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(project, 'slack.mjs')).href,
        CLI_ENTRY,
        'agent',
        '--workflow',
        'workflow.yaml',
        '--provider-module',
        './p.mjs',
      ],
      { cwd: project, env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1' } },
    );
    let out = '';
    first.stdout.on('data', (d: Buffer) => (out += d.toString()));
    first.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<void>((resolve) => first.on('exit', () => resolve()));
    const folder = join(h.path, 'slack-posts');
    // The kill waits for the file to hold the post's `ts`, not only for its name: the exclusive
    // create makes the name first and writes the bytes after, so a kill between the two leaves an
    // empty file, which a restart rightly reads as not usable (CI run 43500728217, under load).
    await until(
      () =>
        existsSync(folder) &&
        readdirSync(folder).some(
          (n) => n.endsWith('.json') && typeof fileIn(join(folder, n))?.['ts'] === 'string',
        ),
      30_000,
    );
    first.kill('SIGKILL');
    await exited;
    const runId = /Run ID: (\S+)/.exec(out)?.[1];
    if (runId === undefined) throw new Error(`fixture: the first agent printed no run id:\n${out}`);
    const gate = (await store.get(runId)).record.pending_gate;
    if (gate === undefined) throw new Error(`fixture: no open question:\n${out}`);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    const written = fileIn(file);
    // The second agent, in this process (a listener set).
    const def = loadWorkflowFromString(yaml);
    const run = handler(def)(runId, gate);
    await until(
      () =>
        onEvent !== undefined &&
        (lines.some((l) => l.includes('already in Slack')) || questionPosts().length > 0),
    );
    const during = fileIn(file);
    onEvent?.({ event_id: 'E9', thread_ts: OLD_TS, user: 'U1', text: 'approve', ts: '9.1' });
    // The reply closes the question. One the agent did not take (it listens on another thread)
    // leaves it open: a terminal answer then closes it, so the cell ends and shows what was done.
    const open = async (): Promise<boolean> =>
      (await store.get(runId)).record.pending_gate !== undefined;
    const end = Date.now() + 5_000;
    while ((await open()) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    const replyTaken = !(await open());
    if (!replyTaken) await terminalAnswer(def, runId, gate);
    await run;
    const { record } = await store.get(runId);
    // (a) red when the restarted agent posts the question again (a dead pid read as running
    //     included), does not take the reply in the old thread, edits another post, or leaves the
    //     file; (b) prints the first agent's output, the file, every Slack call and printed line.
    expect(
      {
        firstWrote: { ts: written?.['ts'], pid: written?.['pid'] },
        questionPosts: questionPosts().length,
        said: lines.filter((l) => l.includes('already in Slack')),
        during: { ts: during?.['ts'], pid: during?.['pid'] },
        thread: bodies('chat.postMessage').map((b) => [b.thread_ts, b.text]),
        replyTaken,
        answered: record.evidence.filter((e) => e.kind === 'gate_response').length,
        edited: bodies('chat.update').map((b) => b.ts),
        file: existsSync(file),
      },
      `the first agent:\n${out}\n${shown()}`,
    ).toEqual({
      firstWrote: { ts: OLD_TS, pid: first.pid },
      questionPosts: 0,
      said: [
        '  ℹ  This question is already in Slack, posted by a realm agent that has stopped; listening on that thread.',
      ],
      during: { ts: OLD_TS, pid: process.pid },
      thread: [[OLD_TS, '✅ Gate resolved: `approve` — run continuing.']],
      replyTaken: true,
      answered: 1,
      edited: [OLD_TS],
      file: false,
    });
  }, 60_000);

  it('check 9b (B.12, no listener): a stopped writer’s file taken over — line (c2), then today’s no-listener line; nothing posted; the old post edited; the file gone', async () => {
    const def = gated('pr6b-9b');
    const { runId, gate } = await openQuestion(def);
    const seeded = seedFile(runId, gate, { channel: CHANNEL, ts: OLD_TS, pid: deadPid() });
    const run = handler(def, { listen: false })(runId, gate);
    await until(() => lines.some((l) => l.includes('Waiting for approval')));
    await terminalAnswer(def, runId, gate);
    await run;
    const said = lines.filter((l) => l.startsWith('  ℹ  '));
    // (a) red when the listening line (c1) is printed with no listener, the order changes, the
    //     question is posted again, or another post is edited; (b) prints every printed line.
    expect(
      {
        said: [said[0], said[1]?.split(';')[0]],
        questionPosts: questionPosts().length,
        edited: bodies('chat.update').map((b) => b.ts),
        file: existsSync(seeded.path),
      },
      shown(),
    ).toEqual({
      said: [
        '  ℹ  This question is already in Slack, posted by a realm agent that has stopped; using that post again.',
        '  ℹ  Gate notification posted',
      ],
      questionPosts: 0,
      edited: [OLD_TS],
      file: false,
    });
  }, 20_000);

  it('check 10: the writer still running (a live process on this host names the file) — a second question post; the file’s bytes unchanged at close', async () => {
    const def = gated('pr6b-10');
    const { runId, gate } = await openQuestion(def);
    // The parent of this test's process is running, and is not this process.
    const seeded = seedFile(runId, gate, { channel: CHANNEL, ts: OLD_TS, pid: process.ppid });
    const run = handler(def)(runId, gate);
    await until(() => questionPosts().length > 0);
    await terminalAnswer(def, runId, gate);
    await run;
    // (a) red when the second agent takes the file over (no post, the file rewritten or deleted);
    //     (b) prints every Slack call and every printed line.
    expect(
      {
        questionPosts: questionPosts().length,
        edited: bodies('chat.update').map((b) => b.ts),
        bytes: existsSync(seeded.path) ? readFileSync(seeded.path, 'utf8') : 'gone',
      },
      shown(),
    ).toEqual({ questionPosts: 1, edited: [POST_TS], bytes: seeded.bytes });
  });

  it('check 11: a stopped file naming another channel — a new post in the configured channel; the file replaced', async () => {
    const def = gated('pr6b-11');
    const { runId, gate } = await openQuestion(def);
    const seeded = seedFile(runId, gate, { channel: 'C999', ts: OLD_TS, pid: deadPid() });
    const run = handler(def)(runId, gate);
    await until(() => questionPosts().length > 0);
    await until(() => fileIn(seeded.path)?.['ts'] === POST_TS, 2_000);
    const during = fileIn(seeded.path);
    await terminalAnswer(def, runId, gate);
    await run;
    // (a) red when the file is taken over (no post; the edit to the other channel's post); (b)
    //     prints the file, every Slack call and every printed line.
    expect(
      {
        posted: questionPosts().map((b) => b.channel),
        during: { channel: during?.['channel'], ts: during?.['ts'], pid: during?.['pid'] },
        edited: bodies('chat.update').map((b) => [b.channel, b.ts]),
        said: lines.filter((l) => l.includes('already in Slack')),
      },
      shown(),
    ).toEqual({
      posted: [CHANNEL],
      during: { channel: CHANNEL, ts: POST_TS, pid: process.pid },
      edited: [[CHANNEL, POST_TS]],
      said: [],
    });
  }, 20_000);

  it('check 12: two takeovers of one stopped file at once — exactly one succeeds; with two agents, the other posts its own question', async () => {
    const def = gated('pr6b-12');
    const { runId, gate } = await openQuestion(def);
    // The takeover itself, twice at once on the same reading.
    const seeded = seedFile(runId, gate, { channel: CHANNEL, ts: OLD_TS, pid: deadPid() });
    const found = await readSlackPostFile(seeded.path, CHANNEL);
    if (found.kind !== 'stopped') throw new Error(`fixture: ${found.kind}`);
    const both = await Promise.all([
      takeOverSlackPostFile(seeded.path, found),
      takeOverSlackPostFile(seeded.path, found),
    ]);
    // Two agents at once on a stopped file.
    seedFile(runId, gate, { channel: CHANNEL, ts: OLD_TS, pid: deadPid() });
    const runs = [handler(def)(runId, gate), handler(def)(runId, gate)];
    await until(() => questionPosts().length > 0);
    await terminalAnswer(def, runId, gate);
    await Promise.all(runs);
    // (a) red when both take the file over; (b) prints the two results, every Slack call and every
    //     printed line.
    expect(
      {
        succeeded: both.filter(Boolean).length,
        said: lines.filter((l) => l.includes('already in Slack')).length,
        questionPosts: questionPosts().length,
        edited: bodies('chat.update')
          .map((b) => b.ts)
          .sort(),
      },
      `the takeovers: ${JSON.stringify(both)}\n${shown()}`,
    ).toEqual({ succeeded: 1, said: 1, questionPosts: 1, edited: [OLD_TS, POST_TS].sort() });
  }, 20_000);

  it('check 13: the file holds exactly the channel, the `ts`, the pid, the host name and the random id; no token', async () => {
    const def = gated('pr6b-13');
    const { runId, gate } = await openQuestion(def);
    const file = slackPostPath(h.path, runId, gate.gate_id);
    const run = handler(def)(runId, gate);
    await until(() => existsSync(file));
    const text = readFileSync(file, 'utf8');
    await terminalAnswer(def, runId, gate);
    await run;
    const held = JSON.parse(text) as Record<string, unknown>;
    // (a) red when the bot token, the signing secret or any other field is written into the file;
    //     (b) prints the file's text.
    expect(
      {
        keys: Object.keys(held).sort(),
        values: [held['channel'], held['ts'], held['pid'], held['host']],
        id: typeof held['id'] === 'string' && held['id'] !== '',
        secret: text.includes(TOKEN) || text.includes(SIGNING),
      },
      `the file: ${text}`,
    ).toEqual({
      keys: ['channel', 'host', 'id', 'pid', 'ts'],
      values: [CHANNEL, POST_TS, process.pid, hostname()],
      id: true,
      secret: false,
    });
  });

  it('check 14: a file that cannot be read — a new question post; the file replaced', async () => {
    const def = gated('pr6b-14');
    const { runId, gate } = await openQuestion(def);
    const path = slackPostPath(h.path, runId, gate.gate_id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"channel": "C123", "ts":');
    const run = handler(def)(runId, gate);
    await until(() => questionPosts().length > 0);
    await until(() => fileIn(path)?.['ts'] === POST_TS, 2_000);
    const during = existsSync(path) ? readFileSync(path, 'utf8') : 'gone';
    await terminalAnswer(def, runId, gate);
    const thrown = await run.then(
      () => undefined,
      (err: unknown) => String(err),
    );
    let replaced: { ts?: unknown; pid?: unknown } | undefined;
    try {
      replaced = JSON.parse(during) as { ts?: unknown; pid?: unknown };
    } catch {
      replaced = undefined;
    }
    // (a) red when the agent throws on the file, or leaves it as it was; (b) prints the file,
    //     every Slack call and every printed line.
    expect(
      {
        thrown,
        questionPosts: questionPosts().length,
        during: replaced === undefined ? during : { ts: replaced.ts, pid: replaced.pid },
      },
      `the file while the question was open: ${during}\n${shown()}`,
    ).toEqual({ thrown: undefined, questionPosts: 1, during: { ts: POST_TS, pid: process.pid } });
  });

  it('check 16: a settings value as the stated name — the edit masks it as the thread’s closing line does; no Slack call carries it', async () => {
    // A value in the agent's environment, 8 characters or more: Realm hides it on every page.
    const VALUE = 'carol.ops@example.com';
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('PR6B_FAKE_OPERATOR', VALUE);
    try {
      const def = gated('pr6b-16');
      const { runId, gate } = await openQuestion(def);
      const run = handler(def)(runId, gate);
      await until(() => questionPosts().length > 0);
      const answered = await submitHumanResponse(store, def, {
        runId,
        gateId: gate.gate_id,
        choice: 'approve',
        respondedBy: VALUE,
        route: 'cli',
        caller: 'respond',
      });
      if (answered.status !== 'ok') throw new Error(`fixture: ${answered.status}`);
      await run;
      const edit = bodies('chat.update')[0];
      const thread = threadPosts();
      const bodiesSent = fetchSpy.mock.calls.map(([, init]) => (init as { body: string }).body);
      // (a) red when the edit sends its closing line without the masking the thread's line has;
      //     (b) prints every Slack call's body and every printed line.
      expect(
        {
          text: edit?.text,
          route: edit?.blocks?.[2]?.text?.text,
          thread,
          carried: bodiesSent.filter((b) => b.includes(VALUE)).length,
        },
        shown(),
      ).toEqual({ text: thread[0], route: thread[0], thread: [thread[0]], carried: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('#729 PR-6b — check 15: the docs’ new sentences', () => {
  const read = (page: string): string =>
    readFileSync(join(ROOT, page), 'utf8').replace(/\s+/g, ' ');
  const GUIDE = 'docs/guides/slack-gates.md';
  const FILES = 'docs/reference/environment-and-files.md';
  const sentences: Array<[string, string]> = [
    [
      GUIDE,
      'When the question closes while `realm agent` attends it, Realm also edits its question post: the post keeps the gate and the question, and the part that said how to answer becomes the closing line, such as `This question is closed: it was answered — send, by "alice" (as stated), from a terminal, at 2026-11-12T10:02:14Z.` The edit needs no new permission: `chat:write` covers it. With only `webhook_url`, Slack gives back no address for the post, so it is not edited; the channel gets the closing line. Added after version 0.49.0.',
    ],
    [
      GUIDE,
      'If `realm agent` stops while a question is open and is started again for the same run, with the same Slack settings, while it is still open, it posts nothing new: it uses the same post, and listens on its thread when a listener is set. It prints `ℹ This question is already in Slack, posted by a realm agent that has stopped; listening on that thread.` (with no listener, `…; using that post again.`). It finds the post through a small file in `~/.realm/slack-posts/`, one per open question, which it deletes when the question closes. A second `realm agent` started while the first is still running posts its own question. So does a restarted one when another program now has the process number the stopped agent had, as can happen after the computer restarts: Realm takes the stopped agent for one still running, and the old post and its file stay as they were. A question that closes while no `realm agent` attends it (answered, or out of time, while `realm agent` was stopped, even if a restarted agent then carries the time limit out) keeps its post as it was, and its file stays. Added after version 0.49.0.',
    ],
    [
      GUIDE,
      "**`⚠ Slack question post not updated to say the question closed — Slack refused the post: message_not_found`.** Realm could not edit its question post when the question closed; after the dash is Slack's reason. `message_not_found`: the post was deleted. `cant_update_message`: another Slack app posted it. The question is closed either way; only the post still reads as open. Added after version 0.49.0.",
    ],
    [
      GUIDE,
      '**`⚠ Slack question post not updated within 2 s; the question is closed`.** The edit did not reach Slack within 2 seconds of the question closing, so Realm went on without it. Added after version 0.49.0.',
    ],
    [
      FILES,
      "| `slack-posts/` | One small file per open Slack question that `realm agent` posted with a bot token: the channel, the post's timestamp, and which `realm agent` process wrote it. Deleted when the question closes. A file stays when the question closed while no `realm agent` attended it, or when a restarted `realm agent` took the stopped one for one still running (the Slack guide says when); a file that stays can be deleted. Added after version 0.49.0. | `realm agent` |",
    ],
  ];
  it.each(sentences)('%s holds the sentence: %s', (page, sentence) => {
    // (a) red when the page no longer holds the sentence word for word; (b) prints the sentence.
    expect(read(page), `${page} no longer says: ${sentence}`).toContain(sentence);
  });
});
