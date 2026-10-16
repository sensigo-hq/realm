// door-laws-729.test.ts — issue #729 PR-0 (PR0-CONTRACT §4, §5, Amendments 9, 11, 13 Q4; D3 A-1,
// A-3, A-17; D4 P-2, P-6): the MCP door's laws, one cell each.
//
// - NARROWING: `register`'s `for` is empty on MCP, so it is an elsewhere entry (the first real
//   narrowing); every way the door removes is listed with why (the conservation law).
// - Q4: an engine step's `run_step` (the operator's lever) never reaches the agent — removed and
//   listed with `engine_step` on a door that serves the agent; an agent step's is untouched.
// - P-6: an operator's command appears only in the block addressed to the person, only when the
//   launching program injected an operator route; never in a structured entry.
// - P-2: every `await` reply carries `poll_after_ms`, and `until` exactly when the record states a
//   deadline for what it waits on; the protocol's `await` text names both.
// - Amendment 9: the published field set — `ways`, `unavailable`, `error.remedy` and the engine's
//   routing fields never leave the door; `error_details` is ONE carrier (the code's typed facts, else
//   the untouched `details`).
// - A-17: a claim token leaves only inside the opening reply's answer.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: field
// names, verbs, tools and booleans — never a token's value.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  buildPreExecutionErrorEnvelope,
  composeWaysOn,
  executeStep,
  narrowForDoor,
  renderUnreadableStoredFile,
  unreadableRunFileError,
  writtenSnapshot,
  type EngineReply,
  type RunRecord,
  type StoredFileClass,
  type WaysContext,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { renderReply, renderWaysOf, mcpDoorPolicy } from './render-reply.js';
import { generateProtocol } from './protocol/generator.js';

const AT = new Date('2026-10-16T12:00:00.000Z');

const BASE = {
  id: 'r',
  workflow_id: 'w',
  params: {},
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  evidence: [],
  terminal_state: false,
  version: 1,
} as unknown as RunRecord;

const ctxOf = (definition: WorkflowDefinition): WaysContext => ({
  definition: { ok: definition },
  enactor: { kind: 'observer' },
  store: { persistsClaims: true },
});

/** An engine step whose input_schema refuses the engine's empty input, consuming no map (T-17). */
const LEVER: WorkflowDefinition = {
  id: 'lever',
  name: 'lever',
  version: 1,
  steps: {
    m: {
      description: 'm',
      execution: 'auto',
      depends_on: [],
      input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'string' } } },
    },
    a: { description: 'a', execution: 'agent', depends_on: [] },
  },
} as WorkflowDefinition;

/** An ok reply over a composition — the shape every engine reply carries its ways in. */
const replyOver = (composed: ReturnType<typeof composeWaysOn>, extra: Partial<EngineReply> = {}) =>
  ({
    command: 'x',
    run_id: 'r',
    run_version: 1,
    status: 'ok',
    data: {},
    evidence: [],
    warnings: [],
    errors: [],
    context_hint: 'h.',
    reply_kind: 'ok',
    ...composed,
    ...extra,
  }) as EngineReply;

describe('#729 PR-0 — the MCP door’s laws', () => {
  it('NARROWING: register is an elsewhere entry (instruction null, for the operator), never a next step', () => {
    const composed = composeWaysOn(writtenSnapshot(BASE, AT), {
      definition: { absent: 'not_registered', workflow_id: 'w' },
      enactor: { kind: 'observer' },
      store: { persistsClaims: true },
    });
    const view = renderWaysOf(composed);
    // (a) red when the door renders register as an instruction or drops it silently; (b) prints
    //     the entries.
    expect({
      next: view.next_actions.map((n) => n.instruction?.tool ?? null),
      elsewhere: view.elsewhere.map((e) => [e.verb, e.instruction, e.for, e.reason]),
    }).toEqual({ next: [], elsewhere: [['register', null, 'operator', 'door_cannot_enact']] });
  });

  it('the conservation law: every way the MCP door removes is listed with why', () => {
    for (const [record, ctx] of [
      [BASE, ctxOf(LEVER)],
      [
        BASE,
        {
          definition: { absent: 'not_registered', workflow_id: 'w' },
          enactor: { kind: 'observer' },
          store: { persistsClaims: true },
        },
      ],
    ] as const) {
      const composed = composeWaysOn(writtenSnapshot(record, AT), ctx as WaysContext);
      const narrowed = narrowForDoor(composed, mcpDoorPolicy({}));
      const kept = new Set(narrowed.ways.map((w) => JSON.stringify({ ...w, for: undefined })));
      const removed = composed.ways.filter(
        (w) => !kept.has(JSON.stringify({ ...w, for: undefined })),
      );
      // A way the door keeps for another party but removes from the agent (Q4's engine_step) is
      // listed too — once per way.
      const agentRemoved = composed.ways.filter(
        (w) => w.verb === 'run_step' && w.brief.execution !== 'agent' && !removed.includes(w),
      );
      const listed = narrowed.unavailable.filter((u) => u.code === 'door_cannot_enact');
      // (a) red when a removed way, or the agent removed from one, is not listed; (b) prints verbs.
      expect(
        listed.map((u) => u.verb).sort(),
        `removed: ${removed.map((w) => w.verb).join(',')}`,
      ).toEqual([...removed, ...agentRemoved].map((w) => w.verb).sort());
    }
  });

  it('Q4: an engine step’s run_step never reaches the agent — listed engine_step for the agent; the operator keeps it; an agent step’s is untouched', () => {
    const composed = composeWaysOn(writtenSnapshot(BASE, AT), ctxOf(LEVER));
    const mcp = narrowForDoor(composed, mcpDoorPolicy({}));
    const cli = narrowForDoor(composed, {
      door: 'cli',
      serves: ['operator', 'asked_person'],
      route: 'cli',
      source: { kind: 'default', ref: 'test' },
    });
    const forOf = (n: typeof mcp, step: string) =>
      n.ways.find((w) => w.verb === 'run_step' && w.step === step)?.for;
    // (a) red when the agent keeps an engine step's lever, or loses its own step; (b) prints the
    //     parties and the listed reasons.
    expect({
      mcpLever: forOf(mcp, 'm'),
      mcpListed: mcp.unavailable
        .filter((u) => u.code === 'door_cannot_enact')
        .map((u) => [
          u.verb,
          u.step ?? null,
          (u.code === 'door_cannot_enact' ? u.facts.reason : undefined) ?? null,
          u.party ?? null,
        ]),
      mcpAgentStep: forOf(mcp, 'a'),
      cliLever: forOf(cli, 'm'),
      cliListed: cli.unavailable.filter((u) => u.code === 'door_cannot_enact').length,
    }).toEqual({
      mcpLever: undefined,
      // register (the refused step's remedy, offered by the linking pass) is the operator's: listed.
      mcpListed: [
        ['register', null, null, null],
        ['run_step', 'm', 'engine_step', 'agent'],
      ],
      mcpAgentStep: ['agent'],
      cliLever: ['operator'],
      cliListed: 0,
    });
  });

  it('P-6: an operator’s command only in the person block, only with an injected route; never in a structured entry', () => {
    const composed = composeWaysOn(writtenSnapshot(BASE, AT), {
      definition: { absent: 'not_registered', workflow_id: 'w', path: '/x/workflow.yaml' },
      enactor: { kind: 'observer' },
      store: { persistsClaims: true },
    });
    const reply = replyOver(composed);
    const route = {
      render: () => 'realm workflow register /x/workflow.yaml',
      source: { kind: 'default' as const, ref: 'test' },
    };
    const withRoute = renderReply(reply, { operatorRoute: route });
    const bare = renderReply(reply);
    // (a) red when a command leaks into a structured entry, or the person block appears without a
    //     route; (b) prints booleans.
    expect({
      personNames:
        withRoute.person?.includes("The operator's command: realm workflow register") ?? false,
      structuredWithRoute: JSON.stringify(withRoute.envelope).includes('realm workflow'),
      bareHasPerson: bare.person !== undefined,
      structuredBare: JSON.stringify(bare.envelope).includes('realm workflow'),
    }).toEqual({
      personNames: true,
      structuredWithRoute: false,
      bareHasPerson: false,
      structuredBare: false,
    });
  });

  it('P-2: an await reply carries poll_after_ms always, and until exactly when the record states the deadline', () => {
    const d: WorkflowDefinition = {
      id: 'held',
      name: 'held',
      version: 1,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    };
    const deadline = '2026-10-16T12:05:00.000Z';
    const stated = { ...BASE, in_progress_steps: ['a'], claims: { a: { deadline, token: 't' } } };
    const unknown = { ...BASE, in_progress_steps: ['a'] };
    const render = (record: unknown) =>
      renderReply(replyOver(composeWaysOn(writtenSnapshot(record as RunRecord, AT), ctxOf(d))))
        .envelope;
    const a = render(stated);
    const b = render(unknown);
    // (a) red when the pace is dropped, or until is invented for an unknown age; (b) prints them.
    expect([
      [a.agent_action, a.poll_after_ms, a.until],
      [b.agent_action, b.poll_after_ms, 'until' in b],
    ]).toEqual([
      ['await', 30_000, deadline],
      ['await', 30_000, false],
    ]);
  });

  it('P-2: the protocol’s await text names poll_after_ms', () => {
    // (a) red when the text drops the pace; (b) prints whether it is named.
    expect(generateProtocol(LEVER).error_handling['await']?.includes('poll_after_ms')).toBe(true);
  });

  it('P-2: the protocol’s await text names until', () => {
    // (a) red when the text drops the deadline; (b) prints whether it is named.
    expect(generateProtocol(LEVER).error_handling['await']?.includes('when until passes')).toBe(
      true,
    );
  });

  it('Amendment 9: the published field set — the ways, the engine’s routing fields and error.remedy never leave the door', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-door-729-')));
    const { run } = await store.create({ workflowId: LEVER.id, workflowVersion: 1, params: {} });
    const replies = [
      await executeStep(store, LEVER, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
      }),
      await executeStep(store, LEVER, {
        runId: run.id,
        command: 'a',
        input: {},
        dispatcher: async () => ({}),
      }),
      await executeStep(store, LEVER, {
        runId: run.id,
        command: 'm',
        input: { n: 5 },
        dispatcher: async () => ({}),
      }),
    ];
    const NEVER = [
      'ways',
      'unavailable',
      'intrinsic_action',
      'reply_kind',
      'refusal',
      'names_next',
    ];
    // (a) red when an engine-only field reaches the wire, or error carries more than `about`;
    //     (b) prints each reply's status and the leaked names.
    expect(
      replies.map((r) => {
        const env = renderReply(r).envelope as Record<string, unknown>;
        const error = env['error'] as Record<string, unknown> | undefined;
        return [
          r.status,
          NEVER.filter((k) => k in env),
          error === undefined ? [] : Object.keys(error).filter((k) => k !== 'about'),
        ];
      }),
    ).toEqual([
      ['ok', [], []],
      ['blocked', [], []],
      ['error', [], []],
    ]);
  });

  it('Amendment 9 / 11: error_details is one carrier — a #719 error’s typed facts; an input refusal’s details byte-identical', async () => {
    const facts = { resource: 'run_file' as const, class: 'parse' as const, path: '/s/r.json' };
    const damaged = buildPreExecutionErrorEnvelope('x', 'r', 0, unreadableRunFileError(facts));
    const envelope = renderReply(damaged).envelope;
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-door-729-')));
    const { run } = await store.create({ workflowId: LEVER.id, workflowVersion: 1, params: {} });
    const refused = await executeStep(store, LEVER, {
      runId: run.id,
      command: 'm',
      input: { n: 5 },
      dispatcher: async () => ({}),
    });
    // (a) red when the facts branch publishes `details`, or the input refusal's `details` is
    //     reshaped; (b) prints the code and booleans.
    expect({
      code: envelope.error_code,
      factsPublished:
        JSON.stringify(envelope.error_details) === JSON.stringify(damaged.error?.facts),
      scope: (envelope.error_details as Record<string, unknown> | undefined)?.['scope'],
      inputCode: refused.error_code,
      inputUntouched:
        JSON.stringify(renderReply(refused).envelope.error_details) ===
        JSON.stringify(refused.error_details),
      inputHasErrors: Array.isArray(
        (refused.error_details as Record<string, unknown> | undefined)?.['errors'],
      ),
    }).toEqual({
      code: 'RESOURCE_FORMAT_INVALID',
      factsPublished: true,
      scope: 'file',
      inputCode: 'VALIDATION_INPUT_SCHEMA',
      inputUntouched: true,
      inputHasErrors: true,
    });
  });

  it('A-17: the token leaves only inside the opening reply’s answer — never in gate, never on a later reply; a stray one is refused at the exit', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-door-729-')));
    const d: WorkflowDefinition = {
      id: 'tok',
      name: 'tok',
      version: 1,
      steps: {
        q: {
          description: 'Ask.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
        side: { description: 'side', execution: 'agent', depends_on: [] },
      },
    } as WorkflowDefinition;
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opening = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    const later = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    const tokensIn = (env: Record<string, unknown>) => {
      const where: string[] = [];
      if ('claim_token' in ((env['gate'] as object | undefined) ?? {})) where.push('gate');
      for (const [i, a] of (
        (env['next_actions'] as Array<{ instruction: { tool: string; params: object } | null }>) ??
        []
      ).entries()) {
        if (a.instruction !== null && 'claim_token' in a.instruction.params) {
          where.push(`next_actions[${i}]:${a.instruction.tool}`);
        }
      }
      return where;
    };
    // (a) red when the token rides the gate, a later reply, or another entry; (b) prints where.
    expect({
      opening: tokensIn(renderReply(opening).envelope as Record<string, unknown>),
      later: tokensIn(renderReply(later).envelope as Record<string, unknown>),
    }).toEqual({ opening: ['next_actions[0]:submit_human_response'], later: [] });
    const planted = {
      ...opening,
      gate: { ...(opening.gate ?? {}), claim_token: 'planted' },
    } as unknown as EngineReply;
    expect(() => renderReply(planted)).toThrow(/claim token reached the wire/);
  });

  it('Amendment 7: every damaged-file class × resource — the MCP door prints #719’s own text, byte for byte, and publishes its facts', () => {
    const extra: Record<StoredFileClass, object> = {
      unreadable: { errno: 'EACCES' },
      parse: { shape: 'array' },
      mismatched: { held_id: 'other-run', held_file: 'absent' },
      not_a_run: { fields: [] },
      empty: { side_files: [] },
      legacy: { side_files: [] },
    };
    // #719's six classes (core's STORED_FILE_CLASSES, not exported): the record type below would
    // refuse a seventh name, and the count is the denominator.
    const CLASSES = Object.keys(extra) as Parameters<
      typeof renderUnreadableStoredFile
    >[0]['class'][];
    const found: string[] = [];
    let cells = 0;
    for (const cls of CLASSES) {
      for (const resource of ['run_file', 'workflow_copy', 'run_folder'] as const) {
        cells += 1;
        const facts = { resource, class: cls, path: `/s/${resource}`, ...extra[cls] } as Parameters<
          typeof renderUnreadableStoredFile
        >[0];
        const reply = buildPreExecutionErrorEnvelope('x', 'r', 0, unreadableRunFileError(facts));
        const env = renderReply(reply).envelope;
        if (env.errors[0] !== renderUnreadableStoredFile(facts))
          found.push(`${cls}×${resource}: text`);
        if (JSON.stringify(env.error_details) !== JSON.stringify({ scope: 'file', ...facts })) {
          found.push(`${cls}×${resource}: facts`);
        }
      }
    }
    // (a) red when a door words a damaged file with a second phrase, or publishes other details;
    //     (b) prints the class×resource cells that differ. The denominator: 6 classes × 3 resources.
    expect({ found, cells }).toEqual({ found: [], cells: 18 });
  });

  it('Table rows 1–4: the answer’s choices are exactly the open gate’s — its declared choices, not a default', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-door-729-')));
    const d = {
      id: 'ch',
      name: 'ch',
      version: 1,
      steps: {
        q: {
          description: 'Ask.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['ship', 'hold', 'drop'] },
        },
      },
    } as WorkflowDefinition;
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    const respond = opened.ways.find((w) => w.verb === 'respond');
    const answer = renderReply(opened).envelope.next_actions.find(
      (n) => n.instruction?.tool === 'submit_human_response',
    );
    // (a) red when the way or its instruction carries other choices than the gate's; (b) prints
    //     the three lists.
    expect({
      gate: (await store.get(run.id)).pending_gate?.choices,
      way: respond?.verb === 'respond' ? respond.choice.one_of : undefined,
      instruction: answer?.instruction?.call_with['choice'],
    }).toEqual({
      gate: ['ship', 'hold', 'drop'],
      way: ['ship', 'hold', 'drop'],
      instruction: '<ship|hold|drop>',
    });
  });

  it('Table rows 28–29: each execute_step entry names a step the reply offers the agent — the callable set, projected', () => {
    const d: WorkflowDefinition = {
      id: 'two',
      name: 'two',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'agent', depends_on: [] },
        c: { description: 'c', execution: 'agent', depends_on: ['a'] },
      },
    };
    const composed = composeWaysOn(writtenSnapshot(BASE, AT), ctxOf(d));
    const env = renderReply(replyOver(composed)).envelope;
    // (a) red when an entry names a step the ways do not offer, or drops one they do; (b) prints
    //     both sets.
    expect({
      entries: env.next_actions
        .filter((n) => n.instruction?.tool === 'execute_step')
        .map((n) => n.instruction?.params['command'])
        .sort(),
      offered: composed.ways
        .filter((w) => w.verb === 'run_step')
        .map((w) => (w.verb === 'run_step' ? w.step : ''))
        .sort(),
    }).toEqual({ entries: ['a', 'b'], offered: ['a', 'b'] });
  });
});
