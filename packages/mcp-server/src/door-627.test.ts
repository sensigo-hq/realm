// door-627.test.ts — #627 W, the MCP door's cells: the per-session tool list (cells 23, 1, 10),
// annotations and the `initialize` capability (cell 24), `list_changed`, abandon's description
// (cell 17), the fallback's approval prompt (cell 11), the protocol per session (cells 23, 28, 12),
// author text labelled (cell 27b, door half), the await entry (W-a1, W-a2, W-a1f; cells 15, 16), the
// door's route and principal (cells 21b, 25), the embedder's setting (cell 4), the held-back reply
// (Part I) and the door-schema witness for `present_question`.
//
// Every server here is built on in-memory transports in ONE process, so a value kept at module level
// (a session's forms) would leak from one session to the next — two sessions on one `asked` server
// configuration get rows 2 and 3 side by side. Every assertion carries (a) the change that turns it
// red and (b) what it prints on failure: tool names, codes, texts — never a token.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARGS,
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  loadWorkflowFromString,
  type EngineReply,
  type RunStore,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createRealmMcpServer,
  INVALID_PRINCIPAL_OPTION,
  REALM_MCP_TAKES_NO_FLAGS,
  type RealmMcpServerOptions,
} from './server.js';
import { effectiveGateAnswers } from './door.js';
import { renderReply, tokenStrayed, type McpEnvelope } from './render-reply.js';

type Reply = Record<string, unknown>;

const WORKFLOW = (opts: { timed?: boolean; side?: boolean; rules?: string } = {}) =>
  [
    'id: door627',
    'name: door627',
    'version: 1',
    ...(opts.rules !== undefined ? ['protocol:', '  rules:', `    - ${opts.rules}`] : []),
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    instructions: Show the draft.',
    '    gate:',
    '      choices: [approve, reject]',
    '      message: Ship it?',
    ...(opts.timed === true ? ['      timeout_seconds: 600', '      on_expiry: abort'] : []),
    '  after:',
    '    description: After.',
    '    execution: agent',
    '    instructions: Write the note.',
    '    depends_on: [q]',
    ...(opts.side === true
      ? ['  side:', '    description: Side.', '    execution: agent', '    instructions: Tidy.']
      : []),
  ].join('\n');

interface Session {
  client: Client;
  call: (name: string, args: Reply) => Promise<Reply>;
  raw: (
    name: string,
    args: Reply,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  tools: () => Promise<string[]>;
  runStore: RunStore;
  workflowStore: JsonWorkflowStore;
  listChanged: () => number;
  elicited: () => number;
}

/** One session: a server built with `options`, a client that declares forms or not. */
async function session(
  options: Omit<RealmMcpServerOptions, 'runStore' | 'workflowStore'> = {},
  client: {
    forms?: boolean;
    onElicit?: () => Promise<{
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    }>;
  } = {},
  stores?: { runStore: RunStore; workflowStore: JsonWorkflowStore },
): Promise<Session> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-door-627-'));
  const runStore = stores?.runStore ?? new JsonFileStore(join(dir, 'runs'));
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore, ...options });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client(
    { name: 'door-627', version: '0' },
    client.forms === true ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  let changed = 0;
  let elicited = 0;
  c.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed++;
  });
  if (client.forms === true) {
    c.setRequestHandler(ElicitRequestSchema, async () => {
      elicited++;
      return (await client.onElicit?.()) ?? { action: 'decline' };
    });
  }
  await Promise.all([server.connect(st), c.connect(ct)]);
  const raw = async (name: string, args: Reply) =>
    (await c.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const text = (await raw(name, args)).content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text };
    }
  };
  // A notification sent during `initialize` lands after the client's connect returns.
  await new Promise((r) => setTimeout(r, 20));
  return {
    client: c,
    call,
    raw,
    tools: async () => (await c.listTools()).tools.map((t) => t.name).sort(),
    runStore,
    workflowStore,
    listChanged: () => changed,
    elicited: () => elicited,
  };
}

async function registered(s: Session, opts: Parameters<typeof WORKFLOW>[0] = {}) {
  const def = loadWorkflowFromString(WORKFLOW(opts));
  await s.workflowStore.register(def);
  return def;
}

/** A run opened at its question OUTSIDE the session (as the CLI or another process would). */
async function openedElsewhere(s: Session, opts: Parameters<typeof WORKFLOW>[0] = {}) {
  const def = await registered(s, opts);
  const { run } = await s.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await advanceRun(s.runStore, def, { runId: run.id });
  const record = await s.runStore.get(run.id);
  return { runId: run.id, gateId: record.pending_gate!.gate_id };
}

const ANSWER = 'submit_human_response';
const PRESENT = 'present_question';

afterEach(() => {
  delete process.env['REALM_MCP_GATE_ANSWERS'];
  delete process.env['REALM_MCP_FORM_WAIT_SECONDS'];
});

// ─── C, B: the per-session tool list (cells 23, 1, 10) ─────────────────────────────────────────

describe('#627 W — which answer tool a session lists', () => {
  it('row by row, by tool NAME: offered → the answer tool; asked with forms → present_question; asked without → the answer tool; withheld → neither', async () => {
    const lists = {
      offered: await (await session({ gateAnswers: 'offered' }, { forms: true })).tools(),
      askedForms: await (await session({}, { forms: true })).tools(),
      askedNoForms: await (await session({})).tools(),
      withheldForms: await (await session({ gateAnswers: 'withheld' }, { forms: true })).tools(),
      withheld: await (await session({ gateAnswers: 'withheld' })).tools(),
    };
    const which = (names: string[]) => [names.includes(ANSWER), names.includes(PRESENT)];
    // (a) red when rows 2 and 3 swap, the answer tool is registered under withheld, or present is
    //     listed off row 2; (b) prints each row's two booleans.
    expect({
      offered: which(lists.offered),
      askedForms: which(lists.askedForms),
      askedNoForms: which(lists.askedNoForms),
      withheldForms: which(lists.withheldForms),
      withheld: which(lists.withheld),
    }).toEqual({
      offered: [true, false],
      askedForms: [false, true],
      askedNoForms: [true, false],
      withheldForms: [false, false],
      withheld: [false, false],
    });
  });

  it('two sessions of one asked configuration in one process keep their own forms (never module-level): the first declares forms, the second not', async () => {
    const withForms = await session({}, { forms: true });
    const without = await session({});
    // (a) red when the session's forms is hoisted to a module-level value set at the first
    //     `initialize`; (b) prints both lists' answer tools.
    expect({
      first: (await withForms.tools()).filter((n) => n === ANSWER || n === PRESENT),
      second: (await without.tools()).filter((n) => n === ANSWER || n === PRESENT),
    }).toEqual({ first: [PRESENT], second: [ANSWER] });
  });

  it('list_changed is sent when initialize moves the session to row 2; a session that stays on its first list gets none', async () => {
    const withForms = await session({}, { forms: true });
    const without = await session({});
    // (a) red when the list is static (no notification), or one is sent with nothing changed;
    //     (b) prints both counts.
    expect({ forms: withForms.listChanged() > 0, noForms: without.listChanged() }).toEqual({
      forms: true,
      noForms: 0,
    });
  });

  it('cell 1 — under withheld a forced call to the answer tool fails, and nothing is recorded', async () => {
    const s = await session({ gateAnswers: 'withheld' });
    const { runId, gateId } = await openedElsewhere(s);
    const forced = await s.raw(ANSWER, { run_id: runId, gate_id: gateId, choice: 'approve' });
    const after = await s.runStore.get(runId);
    // (a) red when the tool is registered regardless of the value; (b) prints the call's error flag
    //     and whether the question is still open.
    expect({
      isError: forced.isError === true,
      stillOpen: after.pending_gate?.gate_id === gateId,
      answers: after.evidence.filter((e) => e.kind === 'gate_response').length,
    }).toEqual({ isError: true, stillOpen: true, answers: 0 });
  });

  it('cell 10 — restarting on one store flips asked → withheld → offered → asked; the store keeps no value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-door-627-flip-'));
    const stores = {
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
    };
    const answerToolOf = async (gateAnswers?: 'withheld' | 'offered') =>
      (
        await (await session(gateAnswers !== undefined ? { gateAnswers } : {}, {}, stores)).tools()
      ).includes(ANSWER);
    // (a) red when the value is cached in the store or the process; (b) prints each server's list.
    expect([
      await answerToolOf(),
      await answerToolOf('withheld'),
      await answerToolOf('offered'),
      await answerToolOf(),
    ]).toEqual([true, false, true, true]);
  });
});

// ─── C: annotations, the capability, abandon's description (cells 24, 17) ──────────────────────

describe('#627 W — the tool list’s annotations and the initialize capability', () => {
  it('cell 24 — every tool is annotated with a title; reads read-only, writes destructive; present_question openWorldHint false, no idempotentHint', async () => {
    const forms = await session({}, { forms: true });
    const fallback = await session({});
    const all = [
      ...(await forms.client.listTools()).tools,
      ...(await fallback.client.listTools()).tools,
    ];
    const byName = new Map(all.map((t) => [t.name, t.annotations]));
    const reads = ['get_run_state', 'get_workflow_protocol', 'list_workflows'];
    const writes = [
      'start_run',
      'start_run_batch',
      'execute_step',
      'advance_run',
      'append_trace',
      'abandon_run',
      'create_workflow',
      ANSWER,
    ];
    // (a) red when one annotation is dropped or flipped; (b) prints the offending tools.
    expect({
      untitled: [...byName].filter(([, a]) => typeof a?.title !== 'string').map(([n]) => n),
      readsNotReadOnly: reads.filter((n) => byName.get(n)?.readOnlyHint !== true),
      writesNotDestructive: writes.filter((n) => byName.get(n)?.destructiveHint !== true),
      present: byName.get(PRESENT),
    }).toEqual({
      untitled: [],
      readsNotReadOnly: [],
      writesNotDestructive: [],
      present: {
        title: "Show the question in the user's app",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
  });

  it('the initialize result names the value and the KIND of its source, never a variable', async () => {
    process.env['REALM_MCP_GATE_ANSWERS'] = 'withheld';
    const s = await session({ gateAnswers: 'offered' });
    const caps = s.client.getServerCapabilities()?.experimental;
    // (a) red when the variable's name or the option's value reaches the capability, or the
    //     restrictive value loses; (b) prints the capability.
    expect({
      cap: caps?.['realm/gate_answers'],
      namesVariable: JSON.stringify(caps).includes('REALM_MCP_GATE_ANSWERS'),
    }).toEqual({ cap: { value: 'withheld', source_kind: 'env' }, namesVariable: false });
  });

  it('cell 17 — abandon_run’s description names no answer tool where none is listed (W-c8); today’s under the fallback and offered', async () => {
    const description = async (s: Session) =>
      (await s.client.listTools()).tools.find((t) => t.name === 'abandon_run')?.description;
    const TODAY =
      'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate (resolve via submit_human_response) and already-terminal runs.';
    const W_C8 =
      'Abandon a non-terminal workflow run (marks it terminal with phase "abandoned"). Refuses runs waiting on a human gate and runs that have already ended.';
    // (a) red when W-c8 is everywhere, or today's text stays where no answer tool is listed;
    //     (b) prints each session's description.
    expect({
      withheld: await description(await session({ gateAnswers: 'withheld' })),
      askedForms: await description(await session({}, { forms: true })),
      fallback: await description(await session({})),
      offered: await description(await session({ gateAnswers: 'offered' })),
    }).toEqual({ withheld: W_C8, askedForms: W_C8, fallback: TODAY, offered: TODAY });
  });

  it('the door-schema witness for present_question: its input is exactly ARGS.present', async () => {
    const s = await session({}, { forms: true });
    const schema = (await s.client.listTools()).tools.find((t) => t.name === PRESENT)
      ?.inputSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    // (a) red when the tool gains an unnamed field, or a field's type or requiredness drifts from
    //     ARGS.present; (b) prints both sides.
    expect({
      fields: Object.fromEntries(
        Object.entries(schema?.properties ?? {}).map(([k, v]) => [k, v.type]),
      ),
      required: [...(schema?.required ?? [])].sort(),
    }).toEqual({
      fields: Object.fromEntries(Object.entries(ARGS.present).map(([k, v]) => [k, v.type])),
      required: Object.entries(ARGS.present)
        .filter(([, v]) => v.required)
        .map(([k]) => k)
        .sort(),
    });
  });
});

// ─── E: the fallback (cell 11) ──────────────────────────────────────────────────────────────────

describe('#627 W — asked’s fallback: the answer tool asks the app to have the person approve it', () => {
  it('cell 11 — _meta and the description’s guidance on the fallback only; W-g1 on its respond entry; the answer records client_prompt_requested and route mcp', async () => {
    const fallback = await session({});
    const offered = await session({ gateAnswers: 'offered' });
    const toolOf = async (s: Session) =>
      (await s.client.listTools()).tools.find((t) => t.name === ANSWER);
    const fb = await toolOf(fallback);
    const off = await toolOf(offered);
    const { runId, gateId } = await openedElsewhere(fallback);
    const state = await fallback.call('get_run_state', { run_id: runId });
    const entry = (state['next_actions'] as Array<{ human_readable: string }>).find((a) =>
      a.human_readable.startsWith('Human review required'),
    );
    await fallback.call(ANSWER, { run_id: runId, gate_id: gateId, choice: 'approve' });
    const recorded = (await fallback.runStore.get(runId)).evidence.find(
      (e) => e.kind === 'gate_response',
    );
    const o = await openedElsewhere(offered);
    await offered.call(ANSWER, { run_id: o.runId, gate_id: o.gateId, choice: 'approve' });
    const offeredEntry = (await offered.runStore.get(o.runId)).evidence.find(
      (e) => e.kind === 'gate_response',
    );
    // (a) red when _meta or the guidance reaches every session, or the fallback answer does not
    //     record the prompt request; (b) prints both tools' _meta, the guidance, the record's facts.
    expect({
      fallbackMeta: fb?._meta,
      offeredMeta: off?._meta,
      fallbackGuidance: fb?.description?.includes(
        'If the call is refused, the run keeps waiting at the gate: tell the user so.',
      ),
      offeredGuidance: off?.description?.includes('If the call is refused'),
      entryGuidance: entry?.human_readable.endsWith(
        "If the call is refused, the run keeps waiting at step 'q': tell the user so.",
      ),
      fallbackRecord: [recorded?.answer, recorded?.client_prompt_requested],
      offeredRecord: [offeredEntry?.answer, offeredEntry?.client_prompt_requested],
    }).toEqual({
      fallbackMeta: { 'anthropic/requiresUserInteraction': true },
      offeredMeta: undefined,
      fallbackGuidance: true,
      offeredGuidance: false,
      entryGuidance: true,
      fallbackRecord: [{ route: 'mcp' }, true],
      offeredRecord: [{ route: 'mcp' }, undefined],
    });
  });

  it('cells 21b, 25 — a route or a principal the tool’s CALLER sends is never recorded: the door’s are', async () => {
    const s = await session({ gateAnswers: 'offered', principal: { kind: 'shared_token' } });
    const { runId, gateId } = await openedElsewhere(s);
    const reply = await s.call(ANSWER, {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
      route: 'mcp_form',
      principal: { kind: 'api_key', id: 'forged' },
    });
    const entry = (await s.runStore.get(runId)).evidence.find((e) => e.kind === 'gate_response');
    // (a) red when the route or the principal is read from the arguments; (b) prints the record's
    //     facts and the reply's warnings.
    expect({
      answer: entry?.answer,
      principal: entry?.principal,
      warned: (reply['warnings'] as string[]).filter((w) =>
        /unknown argument '(route|principal)'/.test(w),
      ).length,
    }).toEqual({ answer: { route: 'mcp' }, principal: { kind: 'shared_token' }, warned: 2 });
  });
});

// ─── H: the protocol per session (cells 23, 28, 12) and author text (cell 27b) ─────────────────

describe('#627 W — the protocol says what this session’s way means', () => {
  async function protocolOf(
    options: Omit<RealmMcpServerOptions, 'runStore' | 'workflowStore'>,
    forms: boolean,
    rules?: string,
  ) {
    const s = await session(options, { forms });
    const def = await registered(s, rules !== undefined ? { rules } : {});
    return s.call('get_workflow_protocol', { workflow_id: def.id });
  }

  it('rule 2, the await rule (W-p4, every value), the value line (W-p5/W-p6/W-p9; none under offered) and the auto+gate step text (W-p8) per session', async () => {
    const view = (p: Reply) => {
      const rules = p['rules'] as string[];
      const q = (p['steps'] as Array<{ id: string; agent_involvement: string }>).find(
        (st) => st.id === 'q',
      )!;
      return {
        rule2: rules[1],
        await: rules.includes(
          'When a next_actions entry has `awaiting` instead of `instruction`, follow its text, even where gate.agent_hint or a workflow rule says otherwise: do not call anything to answer the question.',
        ),
        valueLine: rules[7],
        // Correction 2 (8.6 (h)): read from "opens a gate. " — the forms text no longer says "verbatim".
        step: q.agent_involvement.split('opens a gate. ')[1],
      };
    };
    const offered = view(await protocolOf({ gateAnswers: 'offered' }, true));
    const fallback = view(await protocolOf({}, false));
    const forms = view(await protocolOf({}, true));
    const withheld = view(await protocolOf({ gateAnswers: 'withheld' }, false));
    // (a) red when W-p4 is dropped from offered, the value lines swap, or rule 2 / W-p8 keep the
    //     answer act where the session has no answer tool; (b) prints each session's texts.
    expect({ offered, fallback, forms, withheld }).toEqual({
      offered: {
        rule2:
          "When you receive status 'confirm_required', read gate.agent_hint for instructions when the reply has one, present gate.display to the user verbatim, wait for their response, then call submit_human_response by copying the call in next_actions[0].instruction.call_with and filling in their choice.",
        await: true,
        valueLine: expect.stringMatching(/^Optional: mint a fresh UUIDv4/),
        step: 'Read `gate.agent_hint` for presentation instructions when the reply has one, present `gate.display` to the user verbatim, collect their choice from `gate.response_spec.choices`, and call `submit_human_response` by copying the call in `next_actions[0].instruction.call_with` and filling in the choice.',
      },
      fallback: {
        rule2:
          "When you receive status 'confirm_required', read gate.agent_hint for instructions when the reply has one, present gate.display to the user verbatim, wait for their response, then call submit_human_response by copying the call in next_actions[0].instruction.call_with and filling in their choice. Your client may ask the user to approve that call; if the call is refused, the run keeps waiting at the gate: tell the user so.",
        await: true,
        valueLine:
          'Answers to gates go through submit_human_response; your client may ask the user to approve each call.',
        step: 'Read `gate.agent_hint` for presentation instructions when the reply has one, present `gate.display` to the user verbatim, collect their choice from `gate.response_spec.choices`, and call `submit_human_response` by copying the call in `next_actions[0].instruction.call_with` and filling in the choice. Your client may ask the user to approve that call; if the call is refused, the run keeps waiting at the gate: tell the user so.',
      },
      forms: {
        rule2:
          "When you receive status 'confirm_required', read gate.agent_hint when the reply has one; the user's app shows them the question as a form; follow next_actions.",
        await: true,
        valueLine:
          "Gate questions are sent to the user's app as a form when start_run, execute_step or advance_run first reaches the gate, or when you call present_question; you cannot answer them. Follow the await entry: it says whether a form was sent in this session.",
        step: "Read `gate.agent_hint` for presentation instructions when the reply has one; the user's app shows them the question as a form; follow next_actions.",
      },
      withheld: {
        rule2:
          "When you receive status 'confirm_required', read gate.agent_hint when the reply has one, present gate.display to the user verbatim, and follow next_actions: the question is answered outside this conversation.",
        await: true,
        valueLine:
          'This server records no gate answers. Workflow text that mentions answering tools refers to tools this session does not have.',
        step: 'Read `gate.agent_hint` for presentation instructions when the reply has one, present `gate.display` to the user verbatim, and follow next_actions: the question is answered outside this conversation.',
      },
    });
  });

  it.each([
    ['offered', { gateAnswers: 'offered' as const }, true],
    ['the fallback (asked, no forms)', {}, false],
    ['asked with forms', {}, true],
    ['withheld', { gateAnswers: 'withheld' as const }, false],
  ] as const)(
    'correction 2 (8.6 (g)) — %s: rule 2 and the auto+gate step read gate.agent_hint only when the reply has one',
    async (_label, opts, forms) => {
      const p = await protocolOf(opts, forms);
      const rule2 = (p['rules'] as string[])[1]!;
      const step = (p['steps'] as Array<{ id: string; agent_involvement: string }>).find(
        (st) => st.id === 'q',
      )!.agent_involvement;
      // (a) red when a variant says "read gate.agent_hint" unconditionally (the field exists only
      //     when the author wrote instructions); (b) prints whether each text says when to read it.
      expect({
        rule2: /read gate\.agent_hint( for instructions)? when the reply has one/.test(rule2),
        step: step.includes(
          'Read `gate.agent_hint` for presentation instructions when the reply has one',
        ),
      }).toEqual({ rule2: true, step: true });
    },
  );

  it('correction 2 (8.6 (h)) — asked with a forms client: the protocol says the app shows the question as a form, never "present gate.display"', async () => {
    const p = await protocolOf({}, true);
    const rule2 = (p['rules'] as string[])[1]!;
    const step = (p['steps'] as Array<{ id: string; agent_involvement: string }>).find(
      (st) => st.id === 'q',
    )!.agent_involvement;
    // (a) red when asked-with-forms shares withheld's words (the agent is told to present a question
    //     the form shows); (b) prints whether each text names the form and the presenting act.
    expect({
      ruleForm: rule2.includes(
        "the user's app shows them the question as a form; follow next_actions",
      ),
      rulePresents: rule2.includes('present gate.display'),
      stepForm: step.includes(
        "the user's app shows them the question as a form; follow next_actions",
      ),
      stepPresents: step.includes('present `gate.display`'),
    }).toEqual({ ruleForm: true, rulePresents: false, stepForm: true, stepPresents: false });
  });

  it('correction 2 (8.6 (g), the docs’ claim) — a reply has gate.agent_hint only when the gate’s step has instructions', async () => {
    const hintOf = async (yaml: string) => {
      const s = await session({ gateAnswers: 'offered' });
      await s.workflowStore.register(loadWorkflowFromString(yaml));
      const started = await s.call('start_run', { workflow_id: 'door627', params: {} });
      const gate = started['gate'] as Record<string, unknown> | undefined;
      return [started['status'], gate !== undefined && 'agent_hint' in gate];
    };
    // (a) red when a gate whose step has no instructions carries an agent_hint (the protocol's "when
    //     the reply has one" would then be false), or one with instructions loses it; (b) prints each
    //     reply's status and whether its gate has the field.
    expect({
      withInstructions: await hintOf(WORKFLOW()),
      without: await hintOf(WORKFLOW().replace('    instructions: Show the draft.\n', '')),
    }).toEqual({
      withInstructions: ['confirm_required', true],
      without: ['confirm_required', false],
    });
  });

  it('cell 12 — the protocol under every value names no command and never says the agent may answer ("run respond", "the agent included")', async () => {
    const texts = await Promise.all([
      protocolOf({ gateAnswers: 'offered' }, false),
      protocolOf({}, false),
      protocolOf({}, true),
      protocolOf({ gateAnswers: 'withheld' }, false),
    ]);
    // (a) red when a command or the offered start line's clause reaches the protocol; (b) prints
    //     which session's protocol holds it.
    expect(
      texts.map((p) => {
        const t = JSON.stringify(p);
        return [t.includes('run respond'), t.includes('the agent included')];
      }),
    ).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });

  it('cell 27b — author text is labelled, under every value: a gated step’s instructions and protocol.rules; an ordinary step’s are not', async () => {
    const view = (p: Reply) => {
      const steps = p['steps'] as Array<{ id: string; instructions?: string }>;
      return {
        gated: steps.find((s) => s.id === 'q')?.instructions,
        ordinary: steps.find((s) => s.id === 'after')?.instructions,
        rules: (p['rules'] as string[]).slice(0, 2),
      };
    };
    const expected = {
      gated: "From the workflow's author: Show the draft.",
      ordinary: 'Write the note.',
      rules: ["Rules from the workflow's author:", 'Be brief.'],
    };
    // (a) red when the label is dropped on one surface, or put on an ordinary step; (b) prints each.
    expect([
      view(await protocolOf({ gateAnswers: 'offered' }, false, 'Be brief.')),
      view(await protocolOf({}, true, 'Be brief.')),
      view(await protocolOf({ gateAnswers: 'withheld' }, false, 'Be brief.')),
    ]).toEqual([expected, expected, expected]);
  });

  it('cell 27b — a reply’s gate.agent_hint is labelled as the author’s, under every value', async () => {
    const hintOf = async (
      options: Omit<RealmMcpServerOptions, 'runStore' | 'workflowStore'>,
      forms: boolean,
    ) => {
      const s = await session(
        options,
        forms ? { forms, onElicit: async () => ({ action: 'decline' }) } : {},
      );
      const def = await registered(s);
      const started = await s.call('start_run', { workflow_id: def.id, params: {} });
      return (started['gate'] as { agent_hint?: string } | undefined)?.agent_hint;
    };
    // (a) red when the label is dropped on agent_hint; (b) prints each session's hint.
    expect([
      await hintOf({ gateAnswers: 'offered' }, false),
      await hintOf({}, false),
      await hintOf({ gateAnswers: 'withheld' }, false),
    ]).toEqual([
      "From the workflow's author: Show the draft.",
      "From the workflow's author: Show the draft.",
      "From the workflow's author: Show the draft.",
    ]);
  });
});

// ─── D: the await entry (W-a1, W-a2, W-a1f; cells 15, 16) ───────────────────────────────────────

type Entry = {
  instruction: unknown;
  awaiting?: Record<string, unknown>;
  human_readable: string;
  orientation: string;
};

describe('#627 W — the await entry: a question answered outside this conversation', () => {
  it('under withheld: W-a1 on the reply that carries the gate, W-a2 on a read; no answer call, no token, and the pace — poll_after_ms and until — on both', async () => {
    const s = await session({ gateAnswers: 'withheld' });
    const def = await registered(s, { timed: true });
    const started = await s.call('start_run', { workflow_id: def.id, params: {} });
    const runId = String(started['run_id']);
    const read = await s.call('get_run_state', { run_id: runId });
    const awaitOf = (r: Reply) =>
      (r['next_actions'] as Entry[]).find((a) => a.awaiting !== undefined);
    const opened = awaitOf(started)!;
    const later = awaitOf(read)!;
    const gate = (await s.runStore.get(runId)).pending_gate!;
    // (a) red when an answer call or a token reaches the reply, the gate's reply reads W-a2, the
    //     pace is missing on the reply that opened the question, or `until` is not the deadline;
    //     (b) prints the entries' texts and the pace.
    expect({
      opened: [opened.instruction, opened.human_readable, opened.orientation],
      awaiting: opened.awaiting,
      later: later.human_readable,
      noAnswerCall:
        JSON.stringify(started).includes(ANSWER) || JSON.stringify(read).includes(ANSWER),
      noToken: JSON.stringify(started).includes('claim_token'),
      pace: [started['poll_after_ms'], started['until'], read['until']],
      noWays: ['ways', 'unavailable'].filter((k) => k in started || k in read),
    }).toEqual({
      opened: [
        null,
        `The question on step 'q' of run ${runId} is answered outside this conversation. Show the user gate.display and tell them it is waiting for their answer; an answer they give here is not recorded. Check again no sooner than poll_after_ms; when until passes, tell the user.`,
        `Run is paused at gate '${gate.gate_id}' on step 'q', waiting for an answer outside this conversation.`,
      ],
      awaiting: {
        run_id: runId,
        gate_id: gate.gate_id,
        step: 'q',
        choices: ['approve', 'reject'],
        expires_at: gate.expires_at,
      },
      later: `The question on step 'q' of run ${runId} is answered outside this conversation. Show the user the question — get_run_state's pending_gate.resolved_message when the gate declares a message; otherwise it is shown to them where they answer it — and tell them it is waiting for their answer; an answer they give here is not recorded. Check again no sooner than poll_after_ms; when until passes, tell the user.`,
      noAnswerCall: false,
      noToken: false,
      pace: [30_000, gate.expires_at, gate.expires_at],
      noWays: [],
    });
  });

  it('cell 15 — the time clause appears iff the question has a deadline', async () => {
    const s = await session({ gateAnswers: 'withheld' });
    const def = await registered(s);
    const started = await s.call('start_run', { workflow_id: def.id, params: {} });
    const entry = (started['next_actions'] as Entry[]).find((a) => a.awaiting !== undefined)!;
    // (a) red when "when until passes" prints without a deadline; (b) prints the entry's end.
    expect({
      ends: entry.human_readable.endsWith('Check again no sooner than poll_after_ms.'),
      until: 'until' in started,
      expires: 'expires_at' in (entry.awaiting ?? {}),
    }).toEqual({ ends: true, until: false, expires: false });
  });

  it('asked with forms, a question opened elsewhere: "never sent here", and present_question offered after it', async () => {
    const s = await session({}, { forms: true });
    const { runId } = await openedElsewhere(s);
    const read = await s.call('get_run_state', { run_id: runId });
    const entries = read['next_actions'] as Entry[];
    // (a) red when a read sends a form, the entry says a form was sent, or present_question is not
    //     offered; (b) prints the entries and the forms sent.
    expect({
      elicited: s.elicited(),
      first: entries[0]?.human_readable,
      second: (entries[1]?.instruction as { tool?: string } | undefined)?.tool,
    }).toEqual({
      elicited: 0,
      first: `The question on step 'q' of run ${runId} has not been sent to the user in this session. Call present_question to send it to their app as a form. An answer given in this chat is not recorded. Check again no sooner than poll_after_ms.`,
      second: PRESENT,
    });
  });

  it('cell 16 — C149’s mix: an await entry beside a callable agent step; agent_action follows D-8 (none: a step is callable)', async () => {
    // The engine offers no other step while a question is open, so the mix is a constructed reply:
    // the opening reply's ways plus an agent step's run_step way.
    const s = await session({ gateAnswers: 'withheld' });
    const def = await registered(s);
    const { run } = await s.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opening = await advanceRun(s.runStore, def, { runId: run.id });
    const mixed = {
      ...opening,
      status: 'ok',
      reply_kind: 'ok',
      ways: [
        ...opening.ways,
        {
          verb: 'run_step',
          conditions: [],
          run_id: run.id,
          step: 'side',
          brief: { execution: 'agent', description: 'Side.' },
        },
      ],
    } as unknown as EngineReply;
    const rendered = renderReply(mixed, {
      answers: {
        value: 'withheld',
        source: { kind: 'default', ref: 'test' },
        forms: { shown: false, source: { kind: 'negotiated', ref: 'test' } },
      },
    }).envelope;
    // (a) red when the await entry decides agent_action (await while a step is callable), or the
    //     step's entry is dropped; (b) prints the entries' kinds and the action.
    expect({
      kinds: rendered.next_actions.map((e) =>
        e.awaiting !== undefined ? 'await' : (e.instruction as { tool: string }).tool,
      ),
      action: rendered.agent_action,
      paced: rendered.poll_after_ms,
    }).toEqual({ kinds: ['execute_step', 'await'], action: undefined, paced: 30_000 });
  });

  it('an abandon refused at an open question names no answer tool under withheld (the remedy, narrowed: W-a3)', async () => {
    const s = await session({ gateAnswers: 'withheld' });
    const { runId, gateId } = await openedElsewhere(s);
    const refused = await s.call('abandon_run', { run_id: runId });
    // (a) red when the remedy is rendered un-narrowed ("Answer it: submit_human_response …");
    //     (b) prints the hint.
    expect(refused['context_hint']).toBe(
      `The run is waiting on a human gate, so it cannot be abandoned yet. Run is paused at gate '${gateId}' on step 'q', waiting for an answer outside this conversation.`,
    );
  });
});

// ─── A: the embedder's setting (cell 4) ─────────────────────────────────────────────────────────

describe('#627 W — an embedder: env + option, the most restrictive wins; a bad value builds no server', () => {
  it('cell 4 — effectiveGateAnswers agrees with the server it builds; a bad env refuses with W-s4 (library); a bad wait with W-s8 (library)', async () => {
    const env = { REALM_MCP_GATE_ANSWERS: 'asked' };
    const setting = effectiveGateAnswers({ gateAnswers: 'withheld' }, env);
    process.env['REALM_MCP_GATE_ANSWERS'] = 'asked';
    const s = await session({ gateAnswers: 'withheld' });
    process.env['REALM_MCP_GATE_ANSWERS'] = 'witheld';
    const bad = (() => {
      try {
        createRealmMcpServer({});
      } catch (e) {
        return (e as Error).message;
      }
      return 'built';
    })();
    delete process.env['REALM_MCP_GATE_ANSWERS'];
    const badWait = (() => {
      try {
        createRealmMcpServer({ formWaitSeconds: 10 });
      } catch (e) {
        return (e as Error).message;
      }
      return 'built';
    })();
    // (a) red when the option overrides the env the other way, the two readings disagree, or a bad
    //     value builds a server; (b) prints the setting, the capability and both refusals.
    expect({
      setting: [
        setting.value,
        setting.source.kind,
        setting.alsoSet.map((a) => [a.source.kind, a.value]),
      ],
      capability: s.client.getServerCapabilities()?.experimental?.['realm/gate_answers'],
      bad,
      badWait,
    }).toEqual({
      setting: ['withheld', 'option', [['env', 'asked']]],
      capability: { value: 'withheld', source_kind: 'option' },
      bad: "createRealmMcpServer: invalid REALM_MCP_GATE_ANSWERS value 'witheld': expected asked, offered or withheld — refused: no server is built while it is set, because a misspelt value would leave gate answers handled differently from what you believe. Fix the value where this program reads it, or remove it; a program that reads its environment only at start must be restarted.",
      badWait:
        "createRealmMcpServer: invalid formWaitSeconds value '10': expected a whole number of seconds from 30 to 3600 — refused: no server is built while it is set. Fix the value or remove it.",
    });
  });
});

// ─── I: the held-back reply (W-e1, W-e2) ────────────────────────────────────────────────────────

describe('#627 W — Part I: a token for a handed-off question is held back', () => {
  it('a constructed reply under withheld whose answer instruction would carry a token is replaced by W-e1, and W-e2 is logged', async () => {
    const s = await session({ gateAnswers: 'withheld' });
    const def = await registered(s);
    const { run } = await s.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opening = await advanceRun(s.runStore, def, { runId: run.id });
    const planted = {
      ...opening,
      gate: { ...(opening.gate ?? {}), claim_token: 'planted' },
    } as unknown as EngineReply;
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const held = renderReply(planted, {
      answers: {
        value: 'withheld',
        source: { kind: 'default', ref: 'test' },
        forms: { shown: false, source: { kind: 'negotiated', ref: 'test' } },
      },
    }).envelope;
    spy.mockRestore();
    // (a) red when a token planted on the gate object reaches the wire (PR-0's branch), or PR-0's old
    //     throw returns — the handed-off case (the narrowed opening) is pinned by correction 1's E5
    //     cell; (b) prints the reply's hint and the log line, never the token.
    expect({
      hint: held.context_hint,
      leaked: JSON.stringify(held).includes('planted'),
      logged,
    }).toEqual({
      hint: `Realm held back this reply: it carried a claim token for a question this session cannot answer, which this server never sends. The call itself ran and changed the run (version ${opening.run_version}). This is a fault in Realm or in the program that embeds it, and it was logged. Do not repeat this call: tell the user, and call get_run_state to see where the run stands.`,
      leaked: false,
      logged: [
        `realm: held back a ${opening.command} reply for run ${run.id}: it carried a claim_token on a handed-off question. This is a bug in Realm or in the program embedding it; please report it with this line.`,
      ],
    });
  });
});

describe('#627 W correction 1 (E4, E5) — the held-back reply by row, its arms, and the narrowed opening', () => {
  const ANSWERS = (value: 'offered' | 'withheld') => ({
    value,
    source: { kind: 'default' as const, ref: 'test' },
    forms: { shown: false, source: { kind: 'negotiated' as const, ref: 'test' } },
  });
  async function planted(gateAnswers: 'offered' | 'withheld') {
    const s = await session({ gateAnswers });
    const def = await registered(s);
    const { run } = await s.runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opening = await advanceRun(s.runStore, def, { runId: run.id });
    return {
      run,
      opening,
      plant: (reply: EngineReply) =>
        ({
          ...reply,
          gate: { ...(reply.gate ?? {}), claim_token: 'planted' },
        }) as unknown as EngineReply,
    };
  }
  const held = (reply: EngineReply, host: Parameters<typeof renderReply>[1]) => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const envelope = renderReply(reply, host).envelope;
    spy.mockRestore();
    return { hint: envelope.context_hint, logged };
  };

  it('E4: on offered the clause is the opening reply’s answer instruction, in the text and the log line', async () => {
    const p = await planted('offered');
    // (a) red when the withholding clause prints on a row that does not withhold answers;
    //     (b) prints the hint and the log line, never the token.
    expect(held(p.plant(p.opening), { answers: ANSWERS('offered') })).toEqual({
      hint: `Realm held back this reply: it carried a claim token outside the answer instruction of the reply that opened the question. The call itself ran and changed the run (version ${p.opening.run_version}). This is a fault in Realm or in the program that embeds it, and it was logged. Do not repeat this call: tell the user, and call get_run_state to see where the run stands.`,
      logged: [
        `realm: held back a ${p.opening.command} reply for run ${p.run.id}: it carried a claim_token outside the answer instruction of the reply that opened the question. This is a bug in Realm or in the program embedding it; please report it with this line.`,
      ],
    });
  });

  it('E4: a call that read the run and changed nothing says so ("it changed nothing")', async () => {
    const p = await planted('withheld');
    // A later reply at the open question: no opening token on its ways, the version as read.
    const later = {
      ...p.opening,
      ways: p.opening.ways.map((w) => (w.verb === 'respond' ? { ...w, proof: undefined } : w)),
    } as EngineReply;
    // (a) red when W-e1's changed-nothing arm is missing; (b) prints the hint.
    expect(
      held(p.plant(later), { answers: ANSWERS('withheld'), readVersion: later.run_version }).hint,
    ).toBe(
      'Realm held back this reply: it carried a claim token for a question this session cannot answer, which this server never sends. The call itself ran; it changed nothing. This is a fault in Realm or in the program that embeds it, and it was logged. Do not repeat this call: tell the user, and call get_run_state to see where the run stands.',
    );
  });

  it('E5: the narrowed opening is the withholding rows’ guard — an answer instruction with a token strays where the agent has no respond', () => {
    const envelope = {
      next_actions: [
        {
          instruction: {
            tool: 'submit_human_response',
            params: { claim_token: 't' },
            call_with: {},
          },
          human_readable: '',
        },
      ],
    } as unknown as McpEnvelope;
    const respond = { verb: 'respond', proof: { claim_token: 't' }, conditions: [] };
    const narrowed = (forParties: string[]) =>
      ({ ways: [{ ...respond, for: forParties }], unavailable: [] }) as never;
    // (a) red when the opening is read from the un-narrowed ways (the agent's withheld respond
    //     counted as an opening); (b) prints both verdicts.
    expect({
      withheld: tokenStrayed(envelope, narrowed(['asked_person'])),
      offered: tokenStrayed(envelope, narrowed(['agent', 'asked_person'])),
    }).toEqual({ withheld: true, offered: false });
  });
});

describe('#627 W correction 1 (A4) — the realm-mcp bin takes no flags', () => {
  it('`realm-mcp --gate-answers withheld` refuses the start: one line, exit 1', async () => {
    const bin = fileURLToPath(new URL('../dist/server.js', import.meta.url));
    const home = await mkdtemp(join(tmpdir(), 'realm-door-627-bin-'));
    const r = spawnSync(process.execPath, [bin, '--gate-answers', 'withheld'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home },
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    });
    // (a) red when the bin ignores the flag and starts (it then serves `asked`, the agent keeping an
    //     answer tool in apps without forms); (b) prints the exit and stderr — the server's own
    //     line, never an environment.
    expect({ code: r.status, stderr: r.stderr.trim() }).toEqual({
      code: 1,
      stderr: REALM_MCP_TAKES_NO_FLAGS,
    });
    // Correction 2 (4.5): the words, pinned as words — both variables, and the flag's own program.
    expect(REALM_MCP_TAKES_NO_FLAGS).toBe(
      "realm-mcp takes no flags: set REALM_MCP_GATE_ANSWERS or REALM_MCP_FORM_WAIT_SECONDS in your MCP client's env block, or run realm mcp with the flag.",
    );
  });
});

describe('#627 W correction 2 (4.1) — realm-mcp judges its variables as realm mcp judges its flags', () => {
  const bin = fileURLToPath(new URL('../dist/server.js', import.meta.url));
  /** The built bin with only these variables; stdin closed, so a started server exits after its line. */
  const run = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), 'realm-door-627-bin2-'));
    const r = spawnSync(process.execPath, [bin], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ...env },
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    });
    const lines = r.stderr.trim().split('\n');
    return {
      code: r.status,
      lines: lines.length,
      first: lines[0] ?? '',
      stack: r.stderr.includes('    at '),
    };
  };

  it('a bad REALM_MCP_GATE_ANSWERS refuses the start: one line naming the variable, exit 1, no stack trace', async () => {
    const r = await run({ REALM_MCP_GATE_ANSWERS: 'bogus' });
    // (a) red when the bin builds the server first (a stack trace with the option's words); (b)
    //     prints the exit, the line count, whether it names the variable, and whether a stack shows.
    expect({
      code: r.code,
      lines: r.lines,
      names: r.first.startsWith("realm-mcp: invalid REALM_MCP_GATE_ANSWERS value 'bogus'"),
      stack: r.stack,
    }).toEqual({
      code: 1,
      lines: 1,
      names: true,
      stack: false,
    });
  });

  it('a bad REALM_MCP_FORM_WAIT_SECONDS: the line names the variable, never the library option', async () => {
    const r = await run({ REALM_MCP_FORM_WAIT_SECONDS: '10' });
    // (a) red when the line says the library's "formWaitSeconds"; (b) prints the exit and the line's
    //     opening.
    expect({ code: r.code, first: r.first.split(':').slice(0, 2).join(':') }).toEqual({
      code: 1,
      first: "realm-mcp: invalid REALM_MCP_FORM_WAIT_SECONDS value '10'",
    });
  });

  it('a valid value: stderr’s first line is the start line, naming the variable', async () => {
    const r = await run({ REALM_MCP_GATE_ANSWERS: 'withheld' });
    // (a) red when the bin prints no start line; (b) prints its first stderr line's opening.
    expect(r.first.split('. ')[0]).toBe(
      'Gate answers over MCP: withheld (from REALM_MCP_GATE_ANSWERS)',
    );
  });
});

describe('#627 W correction 2 (4.2, 4.3) — the library refuses an inert form wait and an empty value', () => {
  it('a form wait under withheld, or on a statelessHttp door, builds no server; an empty gateAnswers is refused', () => {
    const build = (options: Parameters<typeof createRealmMcpServer>[0]) => {
      try {
        createRealmMcpServer(options);
        return 'built';
      } catch (e) {
        return (e as Error).message.split(' — ')[0];
      }
    };
    // (a) red when the library builds with a wait no form will use, or reads an empty gateAnswers as
    //     unset; (b) prints what each build did (the refusal's opening).
    expect({
      withheld: build({ gateAnswers: 'withheld', formWaitSeconds: 60 }),
      stateless: build({ statelessHttp: true, formWaitSeconds: 60 }),
      asked: build({ gateAnswers: 'asked', formWaitSeconds: 60 }),
      emptyAnswers: build({ gateAnswers: '' as never }),
    }).toEqual({
      withheld:
        'createRealmMcpServer: the formWaitSeconds option has no effect on this server: it sends no forms under gate answers withheld',
      stateless:
        'createRealmMcpServer: the formWaitSeconds option has no effect on this server: it sends no forms (statelessHttp)',
      asked: 'built',
      emptyAnswers:
        "createRealmMcpServer: invalid gateAnswers option value '': expected asked, offered or withheld",
    });
  });
});

describe('#627 W correction 1 (C1) — the principal option is checked when the server is built', () => {
  it('a principal the total reader cannot read refuses construction; a valid one builds', () => {
    const build = (principal: unknown) => {
      try {
        createRealmMcpServer({ principal: principal as never });
        return 'built';
      } catch (e) {
        return (e as Error).message;
      }
    };
    // (a) red when the server builds with a malformed principal (every answer would carry it);
    //     (b) prints what each build did.
    expect({
      bad: build({ kind: 'api_key' }),
      good: build({ kind: 'api_key', id: 'key-627' }),
    }).toEqual({ bad: INVALID_PRINCIPAL_OPTION, good: 'built' });
  });
});
