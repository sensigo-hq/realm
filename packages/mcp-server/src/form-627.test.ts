// form-627.test.ts — #627 W (§5.2, §5.2b), the form path: cell 21 as one suite, each sub-cell its
// own test (accept; the non-answers; `{}` through SDK 1.31's own elicitInput; an answer after 61 s;
// the client cancelling the call; `present_question` and its cap; the call's re-judgement; the reply
// after the wait from a fresh read; the per-call budget on an injected monotonic clock; the first
// send), no presentation record, the wait helper, `renderOutcome` per branch, a form accepted after
// another route settled, and cell 22 (only a frozen choice for the open gate is an answer).
//
// Every server runs on in-memory transports with a real test client that declares forms; nothing
// here stubs `elicitInput`. Every assertion carries (a) the change that turns it red and (b) what it
// prints on failure: counts, codes, texts — never a token.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  loadWorkflowFromString,
  submitHumanResponse,
  judgeFormWait,
  judgeGateAnswers,
  type Outcome,
  type RunStore,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRealmMcpServer, type RealmMcpServerOptions } from './server.js';
import {
  renderOutcome,
  sendQuestionForm,
  SDK_TIMEOUT_MARGIN_MS,
  WITHDRAWN,
  type ElicitFn,
  type FormDeps,
} from './form-path.js';
import { McpDoor } from './door.js';

type Reply = Record<string, unknown>;
type ElicitReply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
type Handler = (req: {
  params: { message?: string; requestedSchema?: unknown };
  signal: AbortSignal;
}) => Promise<ElicitReply>;

const WORKFLOW = (timeout?: number) =>
  [
    'id: form627',
    'name: form627',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '      message: Ship it?',
    ...(timeout !== undefined
      ? [`      timeout_seconds: ${timeout}`, '      on_expiry: abort']
      : []),
    '  after:',
    '    description: After.',
    '    execution: agent',
    '    depends_on: [q]',
  ].join('\n');

interface Session {
  server: McpServer;
  call: (name: string, args: Reply, signal?: AbortSignal) => Promise<Reply>;
  runStore: RunStore;
  workflowStore: JsonWorkflowStore;
  elicited: () => number;
  /** How many requests the SERVER cancelled on the wire (a withdrawn form). */
  withdrawn: () => number;
  /** The `reason` of each cancel the server sent (correction 1, B11). */
  reasons: () => string[];
  setHandler: (h: Handler) => void;
  workflowId: string;
}

async function session(
  options: Omit<RealmMcpServerOptions, 'runStore' | 'workflowStore'> = {},
  handler: Handler = async () => ({ action: 'decline' }),
  timeout?: number,
  // Correction 1: a workflow of the cell's own, and a store of its own (B5's failing settle).
  own: { yaml?: string; runStore?: (dir: string) => RunStore } = {},
): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-form-627-'));
  const runStore = own.runStore?.(dir) ?? new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const def = loadWorkflowFromString(own.yaml ?? WORKFLOW(timeout));
  await workflowStore.register(def);
  const server = createRealmMcpServer({ runStore, workflowStore, ...options });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'form-627', version: '0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let current = handler;
  let elicited = 0;
  client.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
    elicited++;
    return current({ params: req.params as never, signal: extra.signal });
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  // The server's withdrawal is its `notifications/cancelled` on the wire, counted here with its
  // reason. SDK 1.31's client ignores a cancel for request id 0 (`!requestId`); since correction 1's
  // B2 the server spends id 0 on a ping, so the client's own handler signal shows it too (B2's cells).
  let withdrawn = 0;
  const reasons: string[] = [];
  const deliver = ct.onmessage;
  ct.onmessage = (message, extra) => {
    const m = message as { method?: string; params?: { reason?: unknown } };
    if (m.method === 'notifications/cancelled') {
      withdrawn++;
      reasons.push(String(m.params?.reason));
    }
    deliver?.(message, extra);
  };
  await new Promise((r) => setTimeout(r, 20));
  const call = async (name: string, args: Reply, signal?: AbortSignal): Promise<Reply> => {
    const raw = (await client.callTool(
      { name, arguments: args },
      undefined,
      signal !== undefined ? { signal, timeout: 600_000 } : { timeout: 600_000 },
    )) as { content: Array<{ text: string }> };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text };
    }
  };
  return {
    server,
    call,
    runStore,
    workflowStore,
    elicited: () => elicited,
    withdrawn: () => withdrawn,
    reasons: () => reasons,
    setHandler: (h) => {
      current = h;
    },
    workflowId: def.id,
  };
}

/** A run opened at its question outside the session (the CLI, another process). */
async function openedElsewhere(s: Session, timeout?: number) {
  const def = loadWorkflowFromString(WORKFLOW(timeout));
  const { run } = await s.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(s.runStore, def, { runId: run.id });
  const record = await s.runStore.get(run.id);
  return { runId: run.id, gateId: record.pending_gate!.gate_id, def };
}

const answers = async (s: Session, runId: string) =>
  (await s.runStore.get(runId)).evidence.filter((e) => e.kind === 'gate_response');

const hintOf = (r: Reply) => String(r['context_hint']);
const firstEntry = (r: Reply) =>
  (r['next_actions'] as Array<{ human_readable: string; awaiting?: unknown }>)[0];

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `p` under fake timers: advance `ms`, then keep turning the clock and the I/O until it settles. */
async function drive<T>(p: Promise<T>, ms: number): Promise<T> {
  let done = false;
  void p.finally(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; !done && i < 2_000; i++) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((r) => setImmediate(r));
  }
  return p;
}

// ─── cell 21: the form, one sub-cell per case ───────────────────────────────────────────────────

describe('#627 W — the form path (cell 21)', () => {
  it('a form-capable client gets the form when start_run creates the run; accept records mcp_form with what showed it, and no token', async () => {
    let seen: { message?: string; requestedSchema?: unknown } | undefined;
    const s = await session({}, async (req) => {
      seen = req.params;
      return { action: 'accept', content: { choice: 'approve' } };
    });
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const runId = String(started['run_id']);
    const [entry] = await answers(s, runId);
    // (a) red when the form is not sent, the route or `shown` is lost, a default sneaks onto the
    //     field, or the form path passes a token; (b) prints the form's request and the entry's facts.
    expect({
      elicited: s.elicited(),
      message: seen?.message,
      schema: seen?.requestedSchema,
      answer: entry?.answer,
      proof: entry?.claim_proof,
      choice: entry?.input_summary?.['choice'],
      tokenInForm: JSON.stringify(seen).includes('claim_token'),
    }).toEqual({
      elicited: 1,
      message: 'Ship it?',
      schema: {
        type: 'object',
        properties: {
          choice: { type: 'string', title: 'Your answer', enum: ['approve', 'reject'] },
        },
        required: ['choice'],
      },
      answer: { route: 'mcp_form', shown: { renderer: 'realm-mcp-form/1' } },
      proof: { proof: 'absent' },
      choice: 'approve',
      tokenInForm: false,
    });
  });

  it.each([
    ['decline', async (): Promise<ElicitReply> => ({ action: 'decline' })],
    ['cancel', async (): Promise<ElicitReply> => ({ action: 'cancel' })],
    [
      'a JSON-RPC error from the client',
      async (): Promise<ElicitReply> => {
        throw new Error('the client failed');
      },
    ],
    [
      'accept with {} (SDK 1.31 rejects it: InvalidParams)',
      async (): Promise<ElicitReply> => ({ action: 'accept', content: {} }),
    ],
    [
      'accept with a choice not on the list (cell 22)',
      async (): Promise<ElicitReply> => ({ action: 'accept', content: { choice: 'maybe' } }),
    ],
  ])(
    '%s records nothing: W-f2, the question still waits, the await entry says "came back"',
    async (_label, h) => {
      const s = await session({}, h);
      const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
      const runId = String(started['run_id']);
      // (a) red when a non-answer records something (cancel, say), or the reply says the form is
      //     open; (b) prints the hint, the entry and the answers recorded.
      expect({
        recorded: (await answers(s, runId)).length,
        open: (await s.runStore.get(runId)).pending_gate !== undefined,
        hint: hintOf(started),
        entry: firstEntry(started)?.human_readable,
      }).toEqual({
        recorded: 0,
        open: true,
        hint: "Not recorded: the form came back without an answer. The question on step 'q' is still waiting. To show it again, call present_question (3 left in this session).",
        entry: `The form for step 'q' of run ${runId} came back without an answer 1 time. If the user wants to answer, call present_question (3 left in this session). An answer given in this chat is not recorded. Check again no sooner than poll_after_ms.`,
      });
    },
  );

  it('an answer after 61 s is recorded (Realm passes its own timeout, never the SDK’s 60 s default) — fake timers', async () => {
    const s = await session({}, async () => {
      await new Promise((r) => setTimeout(r, 61_000));
      return { action: 'accept', content: { choice: 'reject' } };
    });
    const { runId, gateId } = await openedElsewhere(s);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await drive(s.call('present_question', { run_id: runId, gate_id: gateId }), 62_000);
    vi.useRealTimers();
    // (a) red when `timeout` is left unset (the SDK ends the wait at 60 s and nothing records);
    //     (b) prints the answers recorded and their choice.
    expect((await answers(s, runId)).map((e) => e.input_summary?.['choice'])).toEqual(['reject']);
  });

  it('Realm’s own timeout is a non-answer: W-f2 says it stopped waiting, after the form-wait cap', async () => {
    const s = await session(
      { formWaitSeconds: 30 },
      (req) =>
        new Promise<ElicitReply>((resolve) => {
          req.signal.addEventListener('abort', () => resolve({ action: 'cancel' }));
        }),
    );
    const { runId, gateId } = await openedElsewhere(s);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const reply = await drive(
      s.call('present_question', { run_id: runId, gate_id: gateId }),
      31_000,
    );
    vi.useRealTimers();
    // (a) red when Realm's timeout is not the cap, or it is reported as an answer; (b) prints the hint.
    expect({ hint: hintOf(reply), recorded: (await answers(s, runId)).length }).toEqual({
      hint: "Not recorded: the form came back without an answer (Realm stopped waiting after 30 s). The question on step 'q' is still waiting. To show it again, call present_question (3 left in this session).",
      recorded: 0,
    });
  });

  it('the client cancelling the call withdraws the form (the call’s signal is passed through)', async () => {
    const s = await session({}, () => new Promise<ElicitReply>(() => undefined));
    const { runId, gateId } = await openedElsewhere(s);
    const controller = new AbortController();
    const pending = s
      .call('present_question', { run_id: runId, gate_id: gateId }, controller.signal)
      .catch(() => 'cancelled');
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    // (a) red when the signal is dropped (the form stays answerable); (b) prints whether it was
    //     withdrawn and what was recorded.
    expect({ withdrawn: s.withdrawn(), recorded: (await answers(s, runId)).length }).toEqual({
      withdrawn: 1,
      recorded: 0,
    });
  });
});

// ─── present_question: again, its cap, its re-judgement; never on a read ────────────────────────

describe('#627 W — present_question', () => {
  it('shows the form again; the cap is 3 more after the first send (W-q2); get_run_state never shows one', async () => {
    const s = await session();
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const runId = String(started['run_id']);
    const gateId = String((await s.runStore.get(runId)).pending_gate!.gate_id);
    for (let i = 0; i < 3; i++)
      await s.call('present_question', { run_id: runId, gate_id: gateId });
    const sentBeforeRead = s.elicited();
    await s.call('get_run_state', { run_id: runId });
    const exhausted = await s.call('present_question', { run_id: runId, gate_id: gateId });
    // (a) red when a read shows the form, or the cap lets a fifth form through; (b) prints the
    //     forms sent and the refusal's hint.
    expect({
      sent: sentBeforeRead,
      afterRead: s.elicited(),
      exhausted: hintOf(exhausted),
      status: exhausted['status'],
    }).toEqual({
      sent: 4,
      afterRead: 4,
      exhausted:
        "The form for step 'q' has been sent 4 times from this server and will not be sent again from here. The user can still answer it outside this conversation.",
      status: 'blocked',
    });
  });

  it('the call re-judges: while a form is open, a second present_question in the same session is refused form_open', async () => {
    let release: (r: ElicitReply) => void = () => undefined;
    const s = await session(
      {},
      () =>
        new Promise<ElicitReply>((resolve) => {
          release = resolve;
        }),
    );
    const { runId, gateId } = await openedElsewhere(s);
    const first = s.call('present_question', { run_id: runId, gate_id: gateId });
    await new Promise((r) => setTimeout(r, 50));
    const second = await s.call('present_question', { run_id: runId, gate_id: gateId });
    release({ action: 'decline' });
    await first;
    // (a) red when the call is judged at offer time only (two forms open); (b) prints the hint and
    //     the forms sent.
    expect({
      sent: s.elicited(),
      refused: hintOf(second).startsWith('A form for the question on step'),
    }).toEqual({
      sent: 1,
      refused: true,
    });
  });

  it('the first send: a deduped start_run, start_run_batch with two runs at open gates and abandon’s refusal send no form; one call sends at most one', async () => {
    const s = await session();
    const keyed = await s.call('start_run', {
      workflow_id: s.workflowId,
      params: {},
      idempotency_key: 'k1',
    });
    const sentAfterCreate = s.elicited();
    await s.call('start_run', { workflow_id: s.workflowId, params: {}, idempotency_key: 'k1' });
    await s.call('start_run_batch', {
      workflow_id: s.workflowId,
      items: [{ params: {} }, { params: {} }],
    });
    await s.call('abandon_run', { run_id: String(keyed['run_id']) });
    // A run keyed ELSEWHERE, at its question, never sent here: the first-send rule would send it, so
    // only the dedupe guard keeps the matching start_run from sending a form.
    const elsewhere = await s.runStore.create({
      workflowId: s.workflowId,
      workflowVersion: 1,
      params: {},
      idempotencyKey: 'k2',
    });
    await advanceRun(s.runStore, loadWorkflowFromString(WORKFLOW()), { runId: elsewhere.run.id });
    await s.call('start_run', { workflow_id: s.workflowId, params: {}, idempotency_key: 'k2' });
    // (a) red when a deduped start_run (of a run this session sent, or of one keyed elsewhere), the
    //     batch or abandon's refusal sends a form, or one call sends two; (b) prints the forms sent.
    expect({ create: sentAfterCreate, after: s.elicited() }).toEqual({ create: 1, after: 1 });
  });

  it('no presentation record: a form sent and declined leaves the run record unchanged', async () => {
    const s = await session();
    const { runId, gateId } = await openedElsewhere(s);
    const before = await s.runStore.get(runId);
    await s.call('present_question', { run_id: runId, gate_id: gateId });
    const after = await s.runStore.get(runId);
    // (a) red when a presentation is appended to `evidence` or the record changes; (b) prints the
    //     versions and the entry counts.
    expect({ version: after.version, entries: after.evidence.length }).toEqual({
      version: before.version,
      entries: before.evidence.length,
    });
  });
});

// ─── the reply after the wait (fresh read), the settle poll, the budget ─────────────────────────

describe('#627 W — after the wait: a fresh read, four branches', () => {
  it('a wait bounded by the deadline, no answer → the advance way, no W-f2', async () => {
    const s = await session(
      {},
      (req) =>
        new Promise<ElicitReply>((resolve) => {
          req.signal.addEventListener('abort', () => resolve({ action: 'cancel' }));
        }),
      2,
    );
    const { runId, gateId } = await openedElsewhere(s, 2);
    const reply = await s.call('present_question', { run_id: runId, gate_id: gateId });
    // (a) red when the reply is composed from the pre-wait snapshot (W-f2 on a due question);
    //     (b) prints the hint and the first entry's tool.
    expect({
      w_f2: hintOf(reply).startsWith('Not recorded: the form came back'),
      tool: (firstEntry(reply) as unknown as { instruction?: { tool?: string } }).instruction?.tool,
    }).toEqual({ w_f2: false, tool: 'advance_run' });
  }, 20_000);

  it('the CLI settles the question during the wait → the form is withdrawn within one poll; the reply is W-f3 ("Meanwhile,")', async () => {
    const box: { s?: Session } = {};
    const s = await session(
      {},
      () =>
        new Promise<ElicitReply>(() => {
          void (async () => {
            const run = await box.s!.runStore.list().then((runs) => runs[0]!);
            const def = loadWorkflowFromString(WORKFLOW());
            await submitHumanResponse(box.s!.runStore, def, {
              runId: run.id,
              gateId: run.pending_gate!.gate_id,
              choice: 'approve',
              route: 'cli',
              respondedBy: 'alice',
            });
          })();
        }),
    );
    box.s = s;
    const { runId, gateId } = await openedElsewhere(s);
    const reply = await s.call('present_question', { run_id: runId, gate_id: gateId });
    await new Promise((r) => setTimeout(r, 100));
    // (a) red when the form stays open after the settle, the reply is W-f2, or the reply names the
    //     CLI's answer command anywhere (correction 1, A1: the agent's route words name no command);
    //     (b) prints the withdrawal count, the hint and whether the command appears.
    expect({
      withdrawn: s.withdrawn(),
      hint: hintOf(reply),
      namesCommand: JSON.stringify(reply).includes('run respond'),
    }).toEqual({
      withdrawn: 1,
      hint: "Meanwhile, the question on step 'q' was answered — approve, by \"alice\" (as stated), through a terminal. Ready for the agent: 'after'.",
      namesCommand: false,
    });
  }, 20_000);

  it('a form accepted after another route settled the question records nothing: W-f3 opens "Not recorded:", with the winner', async () => {
    const box: { s?: Session } = {};
    const s = await session({}, async () => {
      const run = await box.s!.runStore.list().then((runs) => runs[0]!);
      await submitHumanResponse(box.s!.runStore, loadWorkflowFromString(WORKFLOW()), {
        runId: run.id,
        gateId: run.pending_gate!.gate_id,
        choice: 'reject',
        route: 'cli',
      });
      return { action: 'accept', content: { choice: 'approve' } };
    });
    box.s = s;
    const { runId, gateId } = await openedElsewhere(s);
    const reply = await s.call('present_question', { run_id: runId, gate_id: gateId });
    // (a) red when the late accept records, or the reply is W-f2; (b) prints the hint and answers.
    expect({
      hint: hintOf(reply),
      choices: (await answers(s, runId)).map((e) => e.input_summary?.['choice']),
    }).toEqual({
      hint: "Not recorded: the question on step 'q' was answered — reject, through a terminal. Ready for the agent: 'after'.",
      choices: ['reject'],
    });
  });

  it('the per-call budget, on an injected monotonic clock: 90 s spent → the form waits ≤ 150 s; under 20 s left → no form, "never sent here"', async () => {
    // Drive the two readings through the injected clock: the call's start, then the check.
    const readings = [0, 90_000];
    let i = 0;
    const timed = await session(
      { monotonicNow: () => readings[Math.min(i++, readings.length - 1)]! },
      async () => ({ action: 'decline' }),
    );
    const spy2 = vi.spyOn(timed.server.server, 'elicitInput');
    const o = await openedElsewhere(timed);
    await timed.call('present_question', { run_id: o.runId, gate_id: o.gateId });
    // Correction 1 (B11): Realm's own timer is the wait; the SDK's timeout sits a margin above it.
    const sdkTimeout = (spy2.mock.calls[0]?.[1] as { timeout?: number } | undefined)?.timeout;
    const waited = sdkTimeout === undefined ? undefined : sdkTimeout - SDK_TIMEOUT_MARGIN_MS;
    const late = [0, 225_000];
    let j = 0;
    const tight = await session({ monotonicNow: () => late[Math.min(j++, late.length - 1)]! });
    const t = await openedElsewhere(tight);
    const skipped = await tight.call('present_question', { run_id: t.runId, gate_id: t.gateId });
    // (a) red when the cap starts at the form (a 240 s wait) or reads Date.now(); or a form is sent
    //     with under 20 s of the call left; (b) prints the wait and the reply.
    expect({
      waited,
      atMost150: waited !== undefined && waited <= 150_000,
      tightSent: tight.elicited(),
      tightEntry: firstEntry(skipped)?.human_readable.startsWith(
        `The question on step 'q' of run ${t.runId} has not been sent to the user in this session.`,
      ),
    }).toEqual({ waited: 150_000, atMost150: true, tightSent: 0, tightEntry: true });
  });

  it('the wait helper: an unparseable expires_at waits the cap alone and says so on stderr; a due question sends no form', async () => {
    const s = await session({ formWaitSeconds: 60 });
    const spy = vi.spyOn(s.server.server, 'elicitInput');
    const { runId, gateId } = await openedElsewhere(s);
    const record = await s.runStore.get(runId);
    await s.runStore.update({
      ...record,
      pending_gate: { ...record.pending_gate!, expires_at: 'not-a-time' },
    });
    const lines: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    await s.call('present_question', { run_id: runId, gate_id: gateId });
    err.mockRestore();
    const due = await session();
    const d = await openedElsewhere(due, 1);
    await new Promise((r) => setTimeout(r, 1_200));
    await due.call('present_question', { run_id: d.runId, gate_id: d.gateId });
    // (a) red when the wait reads the stamp inline (NaN), says nothing, or a due question gets a
    //     form; (b) prints the wait, the stderr line and the forms sent.
    expect({
      // Correction 1 (B11): Realm's wait is the SDK's timeout less the margin.
      waited: ((t) => t !== undefined && t > 59_000 && t <= 60_000)(
        ((spy.mock.calls[0]?.[1] as { timeout?: number } | undefined)?.timeout ?? NaN) -
          SDK_TIMEOUT_MARGIN_MS,
      ),
      said: lines.some((l) =>
        l.includes('has a deadline this version cannot read; its form waits the cap alone (60 s)'),
      ),
      dueSent: due.elicited(),
    }).toEqual({ waited: true, said: true, dueSent: 0 });
  }, 20_000);
});

// ─── the form path's own guards, called directly ────────────────────────────────────────────────
// Through the MCP tools, three of `sendQuestionForm`'s guards are masked by another mechanism that
// gives the same green: admission refuses a due question before the form path runs; SDK 1.31's
// `elicitInput` rejects an accepted choice that fails the schema; and a cancelled call's reply never
// reaches its client. Each is pinned here on the function, with an injected send.

/** A door on `asked` with forms, and a run opened at its question in a store of its own. */
async function direct(timeout?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-form-627-direct-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const definition = loadWorkflowFromString(WORKFLOW(timeout));
  const { run } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  await advanceRun(runStore, definition, { runId: run.id });
  const gateId = (await runStore.get(run.id)).pending_gate!.gate_id;
  const answersSet = judgeGateAnswers({});
  const waitSet = judgeFormWait({});
  if (!answersSet.ok || !waitSet.ok) throw new Error('fixture: the defaults judge');
  const door = new McpDoor({
    gateAnswers: answersSet.setting,
    formWait: waitSet.setting,
    sendsForms: true,
  });
  door.forms = { ...door.forms, shown: true };
  const deps = (elicit: ElicitFn): FormDeps => ({
    door,
    elicit,
    runStore,
    definition,
    principal: { absent: 'door_authenticates_no_principal' },
  });
  return { runStore, runId: run.id, gateId, door, deps };
}

describe('#627 W — the form path’s own guards, on the function', () => {
  it('a due question sends no form (the due check at the fresh read)', async () => {
    const d = await direct(1);
    await new Promise((r) => setTimeout(r, 1_200));
    let sent = 0;
    const result = await sendQuestionForm(
      d.deps(async () => {
        sent++;
        return { action: 'decline' };
      }),
      d.runId,
      d.gateId,
      { started: d.door.monotonicNow() },
      false,
    );
    // (a) red when a due question opens a form; (b) prints the result and the forms sent.
    expect({ result, sent }).toEqual({ result: { kind: 'not_sent', why: 'due' }, sent: 0 });
  });

  it('an accepted choice not on the list comes back as a non-answer, and nothing is recorded', async () => {
    const d = await direct();
    const result = await sendQuestionForm(
      d.deps(async () => ({ action: 'accept', content: { choice: 'maybe' } })),
      d.runId,
      d.gateId,
      { started: d.door.monotonicNow() },
      false,
    );
    const recorded = (await d.runStore.get(d.runId)).evidence.filter(
      (e) => e.kind === 'gate_response',
    ).length;
    // (a) red when the form path submits a choice outside the gate's choices; (b) prints the
    //     result's kind and the answers recorded.
    expect({ kind: result.kind, recorded }).toEqual({ kind: 'came_back', recorded: 0 });
  });

  it('the call cancelled during the wait withdraws the form, and the withdrawal is not Realm’s timeout', async () => {
    const d = await direct();
    const cancel = new AbortController();
    let withdrawn = false;
    const result = await sendQuestionForm(
      d.deps(
        (_params, options) =>
          new Promise((_resolve, reject) => {
            // As SDK 1.31 does: an aborted request rejects with RequestTimeout (-32001).
            options.signal.addEventListener('abort', () => {
              withdrawn = true;
              reject(Object.assign(new Error('Request timed out'), { code: -32001 }));
            });
            setTimeout(() => cancel.abort(), 20);
          }),
      ),
      d.runId,
      d.gateId,
      { started: d.door.monotonicNow(), signal: cancel.signal },
      false,
    );
    // (a) red when the call's cancel does not reach the form, or a withdrawn form is reported as
    //     Realm's own timeout (`waited_s`, W-f2's "Realm stopped waiting"); (b) prints the result.
    expect({ withdrawn, result }).toEqual({
      withdrawn: true,
      result: { kind: 'came_back', step: 'q', gate_id: d.gateId },
    });
  });
});

// ─── renderOutcome: one phrase per branch (W-f3) ────────────────────────────────────────────────

describe('#627 W — renderOutcome', () => {
  const base = { step: 'q', attempted: false } as const;
  it('one phrase per by.kind and per route absence; the stated name delimited; "Not recorded:" only when this call attempted', () => {
    const r = (o: Partial<Outcome> & Pick<Outcome, 'by'>) =>
      renderOutcome({ ...base, ...o } as Outcome);
    // (a) red when an expiry says "answered", a route absence is spliced into the route template,
    //     the name is not delimited, or the lead ignores `attempted`; (b) prints each phrase.
    expect({
      answer: r({
        by: { kind: 'answer', name: 'alice', basis: 'stated' },
        choice: 'approve',
        via: 'mcp_form',
      }),
      attempted: r({
        by: { kind: 'answer', basis: 'stated' },
        choice: 'approve',
        via: 'mcp',
        attempted: true,
      }),
      undeclared: r({
        by: { kind: 'answer', basis: 'stated' },
        choice: 'reject',
        via: { absent: 'route_not_declared' },
      }),
      unrecorded: r({
        by: { kind: 'answer', basis: 'stated' },
        choice: 'reject',
        via: { absent: 'recorded_without_route' },
      }),
      unknownRoute: r({ by: { kind: 'answer', basis: 'stated' }, choice: 'approve', via: 'slack' }),
      aborted: r({ by: { kind: 'timeout' }, via: { absent: 'settled_by_expiry' } }),
      defaulted: r({
        by: { kind: 'timeout' },
        choice: 'approve',
        via: { absent: 'settled_by_expiry' },
      }),
      engine: r({ by: { kind: 'engine', cause: 'gate_cancelled_by_abort', step: 'check' } }),
    }).toEqual({
      answer:
        "Meanwhile, the question on step 'q' was answered — approve, by \"alice\" (as stated), through the user's app, as a form.",
      attempted:
        "Not recorded: the question on step 'q' was answered — approve, through Realm's MCP answer tool.",
      undeclared:
        "Meanwhile, the question on step 'q' was answered — reject, through a route its program did not declare.",
      unrecorded:
        "Meanwhile, the question on step 'q' was answered — reject; how the answer arrived was not recorded.",
      unknownRoute:
        "Meanwhile, the question on step 'q' was answered — approve, through route 'slack'.",
      aborted:
        "Meanwhile, the question on step 'q' reached its time limit, and the run ended as aborted.",
      defaulted:
        "Meanwhile, the question on step 'q' reached its time limit, and the run took the default approve.",
      engine:
        "Meanwhile, the question on step 'q' was closed because step 'check' aborted the run.",
    });
  });
});

// ─── correction 1: the form path's defects the review found (B1–B11) ────────────────────────────

/** A workflow of this file's shape with its own gate lines and steps after `q`. */
const SHAPE = (gate: string[], after: string[]) =>
  [
    'id: form627',
    'name: form627',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    ...gate.map((l) => `      ${l}`),
    ...after,
  ].join('\n');

/** Waits until `check` holds, or `ms` passes. */
async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

describe('#627 W correction 1 — the form path', () => {
  it('B1: an accepted form’s reply holds no claim_token sentence', async () => {
    const s = await session({}, async () => ({ action: 'accept', content: { choice: 'approve' } }));
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    // (a) red when core composes the token sentence for a form's answer; (b) prints the warnings.
    expect({
      recorded: (await answers(s, String(started['run_id']))).length,
      tokenText: JSON.stringify(started).includes('claim_token'),
      warnings: started['warnings'],
    }).toEqual({ recorded: 1, tokenText: false, warnings: [] });
  });

  it.each([
    [
      'a CLI settle',
      WITHDRAWN.settled,
      undefined as number | undefined,
      async (s: Session) => {
        const run = (await s.runStore.list())[0]!;
        await submitHumanResponse(s.runStore, loadWorkflowFromString(WORKFLOW()), {
          runId: run.id,
          gateId: run.pending_gate!.gate_id,
          choice: 'approve',
          route: 'cli',
        });
      },
    ],
    ['Realm’s timeout', WITHDRAWN.timeout, 3, async () => undefined],
  ] as const)(
    'B2/B11: the FIRST form of a fresh session, withdrawn by %s, is withdrawn on the client too, with its plain reason',
    async (_label, reason, timeout, act) => {
      let aborted = false;
      const box: { s?: Session } = {};
      const s = await session(
        {},
        (req) =>
          new Promise<ElicitReply>((resolve) => {
            req.signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ action: 'cancel' });
            });
            void act(box.s!);
          }),
        timeout,
      );
      box.s = s;
      await s.call('start_run', { workflow_id: s.workflowId, params: {} });
      await until(() => aborted, 3_000);
      // (a) red when the id-0 ping is removed (the first form is id 0, whose cancel the SDK client
      //     ignores), or a withdrawal sends the SDK's raw string; (b) prints both.
      expect({ aborted, reasons: s.reasons() }).toEqual({ aborted: true, reasons: [reason] });
    },
    20_000,
  );

  it('B2/B11: the first form of a fresh session is withdrawn on the client when the client cancels the call', async () => {
    let aborted = false;
    const cancel = new AbortController();
    const s = await session(
      {},
      (req) =>
        new Promise<ElicitReply>((resolve) => {
          req.signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ action: 'cancel' });
          });
          cancel.abort();
        }),
    );
    await s
      .call('start_run', { workflow_id: s.workflowId, params: {} }, cancel.signal)
      .catch(() => undefined);
    await until(() => aborted, 3_000);
    // (a) red when the id-0 ping is removed, or the cancel's reason is the SDK's raw string;
    //     (b) prints both.
    expect({ aborted, reasons: s.reasons() }).toEqual({
      aborted: true,
      reasons: [WITHDRAWN.cancelled],
    });
  }, 20_000);

  it('B3: a gate with no message gets a form whose message is the reply’s gate.display', async () => {
    let message: string | undefined;
    const s = await session(
      {},
      async (req) => {
        message = req.params.message;
        return { action: 'decline' };
      },
      undefined,
      {
        yaml: [
          'id: form627',
          'name: form627',
          'version: 1',
          'steps:',
          '  q:',
          '    description: Ask.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    prompt: Ship the release to production?',
          '    gate:',
          '      choices: [approve, reject]',
        ].join('\n'),
      },
    );
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const display = (started['gate'] as { display?: string } | undefined)?.display;
    // (a) red when the form falls back to the fixed line; (b) prints the form's message and display.
    expect({ message, display }).toEqual({
      message: 'Ship the release to production?',
      display: 'Ship the release to production?',
    });
  });

  it('B4: a form accepted after the run reached a SECOND gate records nothing on it', async () => {
    const yaml = SHAPE(
      ['choices: [approve, reject]'],
      [
        '  q2:',
        '    description: Ask again.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    depends_on: [q]',
        '    gate:',
        '      choices: [approve, reject]',
      ],
    );
    const box: { s?: Session } = {};
    const s = await session(
      {},
      async () => {
        const run = (await box.s!.runStore.list())[0]!;
        const def = loadWorkflowFromString(yaml);
        await submitHumanResponse(box.s!.runStore, def, {
          runId: run.id,
          gateId: run.pending_gate!.gate_id,
          choice: 'reject',
          route: 'cli',
        });
        await advanceRun(box.s!.runStore, def, { runId: run.id });
        return { action: 'accept', content: { choice: 'approve' } };
      },
      undefined,
      { yaml },
    );
    box.s = s;
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const record = await s.runStore.get(String(started['run_id']));
    // (a) red when the door submits the fresh pending_gate's id (the stale form answers gate 2);
    //     (b) prints the open gate's step and the answers recorded per step.
    expect({
      open: record.pending_gate?.step_name,
      answers: record.evidence
        .filter((e) => e.kind === 'gate_response')
        .map((e) => [e.step_id, e.input_summary?.['choice']]),
    }).toEqual({ open: 'q2', answers: [['q', 'reject']] });
  });

  it('B5: an accepted form whose settle fails counts as came back', async () => {
    class FailingSettle extends JsonFileStore {
      // Only the answer's settle fails; opening the gate goes through.
      override async settleStep(
        ...args: Parameters<JsonFileStore['settleStep']>
      ): ReturnType<JsonFileStore['settleStep']> {
        if (args[1].kind === 'settle_gate') throw new Error('the store is full');
        return super.settleStep(...args);
      }
    }
    const s = await session(
      {},
      async () => ({ action: 'accept', content: { choice: 'approve' } }),
      undefined,
      { runStore: (dir) => new FailingSettle(join(dir, 'runs')) },
    );
    const { runId, gateId } = await openedElsewhere(s);
    await s.call('present_question', { run_id: runId, gate_id: gateId }).catch(() => undefined);
    const read = await s.call('get_run_state', { run_id: runId });
    const words = String(firstEntry(read)?.human_readable);
    // (a) red when the form counts as answered before its answer is recorded ("0 times"); (b) prints
    //     the await entry's words.
    expect(words).toContain('came back without an answer 1 time');
  });

  it('B6: start_run’s pre-flight warning survives an accepted first form (guardrail 7(b))', async () => {
    const s = await session(
      {},
      async () => ({ action: 'accept', content: { choice: 'approve' } }),
      undefined,
      {
        yaml: SHAPE(
          ['choices: [approve, reject]', 'message: Ship it?'],
          [
            '  h:',
            '    description: Uses a handler this server lacks.',
            '    execution: auto',
            '    handler: not_installed_627',
            '    depends_on: [q]',
          ],
        ),
      },
    );
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    // (a) red when an accepted form's reply drops the pre-wait warnings; (b) prints the warnings.
    expect((started['warnings'] as string[]).some((w) => w.includes('not_installed_627'))).toBe(
      true,
    );
  });

  it('B7: a run that ends during the form gets start_run’s ways-back-in sentence', async () => {
    const yaml = SHAPE(
      ['choices: [approve, reject]', 'message: Ship it?'],
      [
        '  f:',
        '    description: Fails.',
        '    execution: auto',
        '    handler: fails_627',
        '    depends_on: [q]',
      ],
    );
    const box: { s?: Session } = {};
    const s = await session(
      {},
      async () => {
        const run = (await box.s!.runStore.list())[0]!;
        const def = loadWorkflowFromString(yaml);
        const registry = new ExtensionRegistry();
        registry.register('handler', 'fails_627', {
          id: 'fails_627',
          execute: async () => {
            throw new Error('the step failed');
          },
        });
        await submitHumanResponse(box.s!.runStore, def, {
          runId: run.id,
          gateId: run.pending_gate!.gate_id,
          choice: 'approve',
          route: 'cli',
        });
        await advanceRun(box.s!.runStore, def, { runId: run.id, registry });
        return { action: 'decline' };
      },
      undefined,
      { yaml },
    );
    box.s = s;
    const started = await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const record = await s.runStore.get(String(started['run_id']));
    // (a) red when the tail is read from the record before the wait; (b) prints the phase and hint.
    expect({ ended: record.terminal_state, hint: hintOf(started) }).toEqual({
      ended: true,
      hint: expect.stringContaining('realm run resume'),
    });
  }, 20_000);

  it('B8: a call its client already cancelled gets no form', async () => {
    const d = await direct();
    const cancelled = new AbortController();
    cancelled.abort();
    let sent = 0;
    const result = await sendQuestionForm(
      d.deps(async () => {
        sent++;
        return { action: 'decline' };
      }),
      d.runId,
      d.gateId,
      { started: d.door.monotonicNow(), signal: cancelled.signal },
      false,
    );
    // (a) red when the form is sent for a cancelled call; (b) prints the result and the sends.
    expect({ result, sent }).toEqual({ result: { kind: 'not_sent', why: 'cancelled' }, sent: 0 });
  });

  it('B9: the form carries the tool call’s request id (relatedRequestId)', async () => {
    const s = await session();
    const spy = vi.spyOn(s.server.server, 'elicitInput');
    await s.call('start_run', { workflow_id: s.workflowId, params: {} });
    const related = (spy.mock.calls[0]?.[1] as { relatedRequestId?: unknown } | undefined)
      ?.relatedRequestId;
    // (a) red when the elicitation is sent without the call's id; (b) prints the id's type.
    expect(typeof related).toBe('number');
  });
});
