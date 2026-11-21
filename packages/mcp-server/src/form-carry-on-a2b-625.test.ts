// form-carry-on-a2b-625.test.ts — #625 PR-2b unit A2b (prompt feat-625-a2b-form-carry-on.md): on the
// default `asked`, a form sent by the call that opened the question carries the run on in that call —
// its proof kept inside the server, its time what is left of the form wait. Any other form records the
// answer and leaves the steps to `advance_run`.
//
// A real `createRealmMcpServer` on an in-memory transport whose client shows forms (the form-627
// harness's shape), the door's clock injected where the time matters. Synthetic ids and tokens only:
// a token is compared, never printed. Each assertion carries the two questions of
// `~/.claude/TESTING-RULES.md` rule 8: (a) the change that turns it red; (b) what it prints.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  abandonRun,
  createDefaultRegistry,
  loadWorkflowFromString,
  WorkflowError,
  type ExtensionRegistry,
  type RunStore,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, runsOf, type TempHome } from './test-support/temp-home.js';

type Reply = Record<string, unknown>;
type ElicitReply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

const handles: TempHome[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

interface Session {
  call: (name: string, args: Reply) => Promise<Reply>;
  runStore: RunStore;
  /** Every elicitation request the server sent, as JSON. */
  requests: string[];
  /** The claim tokens on the record while each form was open (the question's own). */
  tokens: string[];
  /** Everything the server wrote to the console during the session. */
  logs: () => string;
}

/** A session whose client shows forms and answers the n-th form (0-based) with `answer(n)`. */
async function session(
  yaml: string,
  answer: (n: number) => ElicitReply,
  opts: { monotonicNow?: () => number; registry?: ExtensionRegistry } = {},
): Promise<Session> {
  const h = await makeTempHome();
  handles.push(h);
  await h.stores.workflowStore.register(loadWorkflowFromString(yaml));
  const logged: string[] = [];
  for (const level of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
  }
  const server = createRealmMcpServer({
    ...h.stores,
    ...(opts.monotonicNow !== undefined ? { monotonicNow: opts.monotonicNow } : {}),
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'form-carry-on-a2b', version: '0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const requests: string[] = [];
  const tokens: string[] = [];
  let n = 0;
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    requests.push(JSON.stringify(req.params));
    for (const snap of await runsOf(h.stores.runStore)) {
      for (const claim of Object.values(snap.record.claims ?? {})) {
        if (typeof claim?.token === 'string') tokens.push(claim.token);
      }
    }
    return answer(n++);
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await new Promise((r) => setTimeout(r, 20));
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore: h.stores.runStore, requests, tokens, logs: () => logged.join('\n') };
}

const ACCEPT: ElicitReply = { action: 'accept', content: { choice: 'approve' } };
const gateYaml = (steps: string[]): string =>
  [
    'id: a2b',
    'name: a2b',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '      message: Ship it?',
    ...steps,
  ].join('\n');
/** gate `q`, then `a` and `b` (auto), then agent step `finish`. */
const CHAIN = gateYaml([
  '  a:',
  '    description: A.',
  '    execution: auto',
  '    depends_on: [q]',
  '  b:',
  '    description: B.',
  '    execution: auto',
  '    depends_on: [a]',
  '  finish:',
  '    description: Finish.',
  '    execution: agent',
  '    depends_on: [b]',
]);

const claimOf = (r: Reply) => r['gate_claim'] as Record<string, unknown> | undefined;
const hintOf = (r: Reply) => String(r['context_hint'] ?? '');
const stepsOf = (r: Reply) =>
  ((r['chained_auto_steps'] as Array<{ step: string }> | undefined) ?? []).map((c) => c.step);
const occurrences = (text: string, part: string) => text.split(part).length - 1;
/** Whether any captured token appears in `text`. */
const leaks = (s: Session, text: string) => s.tokens.some((t) => t.length > 0 && text.includes(t));

describe('#625 PR-2b A2b — a form sent by the call that opened the question carries the run on', () => {
  it('check 1 (in process) and check 4: start_run’s form, accepted — the steps run in that call; the token never in the form, a log or the reply', async () => {
    const s = await session(CHAIN, () => ACCEPT);
    const reply = await s.call('start_run', { workflow_id: 'a2b' });
    const { record } = await s.runStore.get(String(reply['run_id']));
    const entry = record.evidence.filter((e) => e.kind === 'gate_response').at(-1);
    // (a) red when the form's answer passes no token (proof_absent, a and b owed), or the token
    //     reaches the elicitation request, a log line or the reply; (b) prints the fields and booleans.
    expect({
      carried: claimOf(reply)?.['carried_on'],
      proof: claimOf(reply)?.['proof'],
      recorded: entry?.claim_proof,
      chained: stepsOf(reply),
      done: record.completed_steps,
      tokenSeen: s.tokens.length > 0,
      inRequest: s.requests.some((r) => leaks(s, r)),
      inLog: leaks(s, s.logs()),
      inReply: leaks(s, JSON.stringify(reply)),
    }).toEqual({
      carried: true,
      proof: 'matched',
      recorded: { proof: 'matched' },
      chained: ['a', 'b'],
      done: ['q', 'a', 'b'],
      tokenSeen: true,
      inRequest: false,
      inLog: false,
      inReply: false,
    });
  });

  it('check 2: in the opening call’s session, the opening form declined, then present_question’s form accepted — recorded, not carried on, the owed sentence names advance_run', async () => {
    const s = await session(CHAIN, (n) => (n === 0 ? { action: 'decline' } : ACCEPT));
    const opened = await s.call('start_run', { workflow_id: 'a2b' });
    const runId = String(opened['run_id']);
    const gateId = (await s.runStore.get(runId)).record.pending_gate!.gate_id;
    const reply = await s.call('present_question', { run_id: runId, gate_id: gateId });
    const { record } = await s.runStore.get(runId);
    // (a) red when present_question's form passes the opening token (a token kept on the door per
    //     gate, or read from the store) and carries the run on; (b) prints the fields.
    expect({
      recorded: record.evidence.filter((e) => e.kind === 'gate_response').length,
      claim: [claimOf(reply)?.['carried_on'], claimOf(reply)?.['not_carried_on_because']],
      done: record.completed_steps,
      owed: occurrences(hintOf(reply), "Owed to the engine: 'a' — call advance_run."),
      noSentence: (reply['warnings'] as string[]).filter((w) => w.includes('claim_token')),
      inReply: leaks(s, JSON.stringify(reply)),
    }).toEqual({
      recorded: 1,
      claim: [false, 'proof_absent'],
      done: ['q'],
      owed: 1,
      noSentence: [],
      inReply: false,
    });
  });

  it('check 3: a form answered after the form wait’s time is spent — no step is claimed, the reply says why once', async () => {
    let now = 0;
    const s = await session(
      CHAIN,
      () => {
        // The person answers 241 s after the call began (the wait's own timer is real time).
        now = 241_000;
        return ACCEPT;
      },
      { monotonicNow: () => now },
    );
    const reply = await s.call('start_run', { workflow_id: 'a2b' });
    const { record } = await s.runStore.get(String(reply['run_id']));
    const said =
      "This call's time ran out after 'q'; the run was not carried further in this call.";
    // (a) red when the answer gets a fresh budget (`a` runs), or the mcp_form rule suppresses the
    //     sentence; (b) prints the fields.
    expect({
      done: record.completed_steps,
      claimOnA: record.claims?.['a'],
      stopped: claimOf(reply)?.['chain_stopped'],
      said: (reply['warnings'] as string[]).filter((w) => w === said).length,
      owed: occurrences(hintOf(reply), "Owed to the engine: 'a' — call advance_run."),
    }).toEqual({ done: ['q'], claimOnA: undefined, stopped: 'budget', said: 1, owed: 1 });
  });

  it('check 5: the carry-on reaches a new question inside the form’s call — an awaiting entry, no second form, no copied token', async () => {
    const yaml = gateYaml([
      '  a:',
      '    description: A.',
      '    execution: auto',
      '    depends_on: [q]',
      '  r:',
      '    description: Review.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    depends_on: [a]',
      '    gate:',
      '      choices: [ship, hold]',
      '      message: Ship now?',
    ]);
    const s = await session(yaml, () => ACCEPT);
    const reply = await s.call('start_run', { workflow_id: 'a2b' });
    const first = (reply['next_actions'] as Array<Record<string, unknown>>)[0];
    const awaiting = first?.['awaiting'] as Record<string, unknown> | undefined;
    // (a) red when a second form is sent on the carried-on reply, or the first question's token is
    //     on the reply; (b) prints the fields and booleans.
    expect({
      status: reply['status'],
      forms: s.requests.length,
      awaitingStep: awaiting?.['step'],
      instruction: first?.['instruction'] ?? null,
      firstToken: leaks(s, JSON.stringify(reply)),
      carried: claimOf(reply)?.['carried_on'],
    }).toEqual({
      status: 'confirm_required',
      forms: 1,
      awaitingStep: 'r',
      instruction: null,
      firstToken: false,
      carried: true,
    });
  });

  it('check 7: the step after the gate fails, after execute_step’s form — the answer recorded, the act’s opening, the way back in once', async () => {
    const registry = createDefaultRegistry();
    registry.register('handler', 'always_fail', {
      id: 'always_fail',
      execute: async () => {
        throw new WorkflowError('Handler deliberately failed', {
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        });
      },
    } as never);
    const yaml = [
      'id: a2b',
      'name: a2b',
      'version: 1',
      'steps:',
      '  w:',
      '    description: Write.',
      '    execution: agent',
      '  q:',
      '    description: Ask.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    depends_on: [w]',
      '    gate:',
      '      choices: [approve, reject]',
      '      message: Ship it?',
      '  a:',
      '    description: A.',
      '    execution: auto',
      '    handler: always_fail',
      '    depends_on: [q]',
      '  finish:',
      '    description: Finish.',
      '    execution: agent',
      '    depends_on: [a]',
    ].join('\n');
    const s = await session(yaml, () => ACCEPT, { registry });
    const started = await s.call('start_run', { workflow_id: 'a2b' });
    const runId = String(started['run_id']);
    const reply = await s.call('execute_step', { run_id: runId, command: 'w', params: {} });
    const hint = hintOf(reply);
    const resume = `To make the failed step runnable again: realm run resume ${runId} --from a`;
    // (a) red when formAnswerRecorded reads the merged `status` (the reply becomes "came back" /
    //     "Not recorded"), the act's opening is lost, or the way back in is missing or doubled;
    //     (b) prints the fields. (`came_back` 0 on the door: form-recorded-627's carried-on row.)
    expect({
      status: reply['status'],
      stopped: reply['stopped_step'],
      carried: claimOf(reply)?.['carried_on'],
      opens: hint.startsWith("Step 'w' completed. "),
      answerOnce: occurrences(hint, "Gate 'q' resolved with choice 'approve'."),
      notRecorded: hint.includes('Not recorded'),
      resumeOnce: occurrences(hint, resume),
      endsWithResume: hint.endsWith(resume),
    }).toEqual({
      status: 'error',
      stopped: 'a',
      carried: true,
      opens: true,
      answerOnce: 1,
      notRecorded: false,
      resumeOnce: 1,
      endsWithResume: true,
    });
  });

  it('item 4: after the form, a carried-on reply whose continuation meets another program ending the run says how it ended, once', async () => {
    // `a` runs in the carry-on; while it runs another program abandons the run (a `run_ended` race).
    const target: { store?: RunStore } = {};
    const registry = createDefaultRegistry();
    registry.register('handler', 'end_it', {
      id: 'end_it',
      execute: async (_inputs: unknown, ctx: { run_id?: string; runId?: string }) => {
        const runs = await runsOf(target.store!);
        const open = runs.find((r) => !r.record.terminal_state)!;
        await abandonRun(target.store!, open.record.id, 'another program');
        void ctx;
        return { data: {} };
      },
    } as never);
    const yaml = gateYaml([
      '  a:',
      '    description: A.',
      '    execution: auto',
      '    handler: end_it',
      '    depends_on: [q]',
      '  finish:',
      '    description: Finish.',
      '    execution: agent',
      '    depends_on: [a]',
    ]);
    const s = await session(yaml, () => ACCEPT, { registry });
    target.store = s.runStore;
    const reply = await s.call('start_run', { workflow_id: 'a2b' });
    const said = 'It was abandoned, with the reason "another program".';
    // (a) red when the opening tool's tail never says how the run ended on a carried-on reply after
    //     a form (it said so only on the engine's own reply), or says it twice; (b) prints the fields.
    expect({
      said: occurrences(hintOf(reply), said),
      phase: reply['run_phase'],
      carried: claimOf(reply)?.['carried_on'],
    }).toEqual({ said: 1, phase: 'abandoned', carried: true });
  });
});
