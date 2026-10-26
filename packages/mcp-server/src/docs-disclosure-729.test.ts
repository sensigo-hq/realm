// #729 PR-3 (prompt 05 "Docs claims"; guardrail 9): the MCP pages' sentences about the `disclosure`
// receipt, quoted exactly, asserted to still be on their page, and executed over a real server: every
// tool that replies with a JSON object ends its reply with `disclosure`; `get_workflow_protocol`'s
// plain-text refusal carries none. Every value is fake. Each assertion names (a) the change that
// turns it red and (b) what it prints: tool names, key names and booleans.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  buildDisclosureSet,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOLS_PAGE = 'docs/reference/mcp/tools.md';
const CONNECT_PAGE = 'docs/guides/connect-an-mcp-client.md';
const LIBRARY_PAGE = 'docs/reference/core-library.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    `${page} no longer says: ${sentence}`,
  ).toBe(true);
}

const FLOW: WorkflowDefinition = {
  id: 'docs-flow',
  name: 'docs flow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

async function connect(extra: Parameters<typeof createRealmMcpServer>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-docs-mcp-729-'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(FLOW);
  const server = createRealmMcpServer({
    runStore: new JsonFileStore(join(dir, 'runs')),
    workflowStore,
    ...extra,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-729', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  /** The reply's first block: a JSON object's keys, or `text` for a reply that is not JSON. */
  return async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    const text = raw.content[0]!.text;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { keys: Object.keys(parsed), body: parsed as Record<string, unknown> }
        : { keys: ['text'], body: {} };
    } catch {
      return { keys: ['text'], body: {} };
    }
  };
}

describe('#729 PR-3 — the MCP pages: `disclosure` on every JSON reply', () => {
  it('every tool that replies with a JSON object ends it with `disclosure`; the plain-text refusal has none', async () => {
    claim(
      TOOLS_PAGE,
      "Every reply that is a JSON object, `list_workflows`'s and `get_workflow_protocol`'s included, carries `disclosure`; `get_workflow_protocol`'s plain-text refusal does not.",
    );
    claim(
      TOOLS_PAGE,
      "What Realm hid from the reply before the agent read it: `declared` (whether Realm knew the secrets a deployment manifest declares: `resolved`, `partial` or `unknown`, with `declared_cause` when not `resolved`), `environment` (`swept` when the server's environment variables were checked), `hidden` (how many values were replaced with `[REDACTED]`, by kind: `declared`, `environment`, `pattern`), `unchecked` (always `0` in this version), `unmaskable` (declared secrets too short to hide), `too_deep` (values shown as their type and size because they lie more than 64 levels deep) and, when the reply shows a gate's question, `question: declared_only` (the question hides only the declared secrets).",
    );
    claim(
      CONNECT_PAGE,
      'Every reply in JSON ends with `disclosure`: what Realm hid from the reply before the assistant read it.',
    );
    const call = await connect();
    const started = await call('start_run', { workflow_id: FLOW.id, params: {} });
    const runId = started.body['run_id'] as string;
    const replies = {
      list_workflows: await call('list_workflows', {}),
      get_workflow_protocol: await call('get_workflow_protocol', { workflow_id: FLOW.id }),
      start_run: started,
      start_run_batch: await call('start_run_batch', {
        workflow_id: FLOW.id,
        items: [{ params: {} }],
      }),
      append_trace: await call('append_trace', {
        run_id: runId,
        step_id: 'a',
        entries: [{ event: 'e' }],
      }),
      execute_step: await call('execute_step', { run_id: runId, command: 'a', params: {} }),
      get_run_state: await call('get_run_state', { run_id: runId }),
      advance_run: await call('advance_run', { run_id: runId }),
      submit_human_response: await call('submit_human_response', {
        run_id: runId,
        gate_id: 'no-such-gate',
        choice: 'approve',
      }),
      abandon_run: await call('abandon_run', { run_id: runId }),
      create_workflow: await call('create_workflow', {
        steps: [{ id: 'only', description: 'Only.' }],
      }),
    };
    const refusal = await call('get_workflow_protocol', { workflow_id: 'no-such-workflow' });
    const receiptKeys = Object.keys(
      replies.list_workflows.body['disclosure'] as Record<string, unknown>,
    );
    // (a) red when a tool's JSON reply loses its receipt or carries it elsewhere than last, the
    //     receipt's keys change, or the text refusal gains one; (b) prints, per tool, the last key.
    expect({
      last: Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, v.keys.at(-1)])),
      receiptKeys,
      refusal: refusal.keys,
    }).toEqual({
      last: Object.fromEntries(Object.keys(replies).map((k) => [k, 'disclosure'])),
      receiptKeys: [
        'declared',
        'declared_cause',
        'environment',
        'hidden',
        'unchecked',
        'unmaskable',
        'too_deep',
      ],
      refusal: ['text'],
    });
  });
});

describe("#729 PR-3 — the library page: createRealmMcpServer's disclosure options", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("no provider: the environment, `embedder_none`; a throwing one: `load_failed`; a provider's set is used; notSecret shows a name", async () => {
    claim(
      LIBRARY_PAGE,
      '| `disclosureProvider` | The environment alone, the reply saying `declared: unknown` (`declared_cause: embedder_none`) |',
    );
    claim(
      LIBRARY_PAGE,
      'When it throws, the reply is masked with the environment and says `declared_cause: load_failed`.',
    );
    // Correction 3 (H-11'): a throwing provider's `load_failed` withholds the reply's values.
    claim(
      LIBRARY_PAGE,
      'Its values then print as their type and size and its question is withheld, as for any reply whose `declared_cause` is `load_failed` or `manifest_changed`.',
    );
    claim(
      'CHANGELOG.md',
      "when it throws, a reply's values also print as their type and size and its question is withheld.",
    );
    claim(
      LIBRARY_PAGE,
      '`{ notSecret }`: names of environment variables whose values replies show, as `REALM_NOT_SECRET` does, when no `disclosureProvider` is given or it throws.',
    );
    vi.stubEnv('REALM_NOT_SECRET', '');
    vi.stubEnv('DOCS_729_ENV', 'FAKE-DOCS-ENV-0729');
    vi.stubEnv('DOCS_729_SHOWN', 'FAKE-DOCS-SHOWN-0729');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const params = { e: 'FAKE-DOCS-ENV-0729', s: 'FAKE-DOCS-SHOWN-0729', d: 'FAKE-DOCS-DECL-0729' };
    const shownBy = async (extra: Parameters<typeof createRealmMcpServer>[0]) => {
      const call = await connect(extra);
      const started = await call('start_run', { workflow_id: FLOW.id, params });
      const state = await call('get_run_state', { run_id: started.body['run_id'] as string });
      const text = JSON.stringify(state.body);
      const receipt = state.body['disclosure'] as { declared: string; declared_cause?: string };
      return [
        receipt.declared,
        receipt.declared_cause ?? null,
        text.includes(params.e),
        text.includes(params.s),
        text.includes(params.d),
      ];
    };
    const notSecret = { disclosure: { notSecret: ['DOCS_729_SHOWN'] } };
    // (a) red when the default, the throwing provider's fallback, the provider's set or the
    //     notSecret names change behaviour; (b) prints, per case, the receipt's state and cause and
    //     whether each fake value shows.
    expect({
      none: await shownBy(notSecret),
      throws: await shownBy({
        ...notSecret,
        disclosureProvider: async () => {
          throw new Error('fake provider failure');
        },
      }),
      provider: await shownBy({
        ...notSecret,
        disclosureProvider: async () =>
          buildDisclosureSet({
            env: process.env,
            declared: { D: params.d },
            declaredState: 'resolved',
            audience: 'agent',
          }).set,
      }),
    }).toEqual({
      none: ['unknown', 'embedder_none', false, true, true],
      // Correction 3 (H-11'): withheld, so neither the listed value nor the unknown declared one shows.
      throws: ['unknown', 'load_failed', false, false, false],
      provider: ['resolved', null, false, false, false],
    });
  });
});

describe('#729 PR-3 correction 1 — whose standing a reply reports (F11, D-11), and its new keys (F15, F16)', () => {
  const GATED: WorkflowDefinition = {
    id: 'docs-gated',
    name: 'gated',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      g: {
        description: 'G.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], message: 'Approve it?' },
      },
    },
  } as WorkflowDefinition;

  it("each reply reports its workflow's standing, a list the weakest; a shown question says so; the provider gets the workflow and the run", async () => {
    claim(
      TOOLS_PAGE,
      '`declared` is about the workflow the reply is about; a reply about several, such as `list_workflows`, gives the weakest.',
    );
    claim(
      CONNECT_PAGE,
      'A reply about several workflows, such as `list_workflows`, gives the weakest of theirs.',
    );
    claim(
      CONNECT_PAGE,
      "When a reply shows a gate's question, `question: declared_only` says the question hides only the declared secrets.",
    );
    claim(
      CONNECT_PAGE,
      '`unknown`, with `declared_cause: load_failed` when the manifest or a secret it names could not be read, or `no_manifest` when the workflow has no project.',
    );
    claim(
      LIBRARY_PAGE,
      "A function given the workflow a reply is about (or `undefined`) and, when the call names a run, that run; it returns the set the reply is masked with: `buildDisclosureSet` from `@sensigo/realm`, with your declared secrets and `audience: 'agent'`. The reply reports that set's `declared` and `declared_cause`; a reply about several workflows (`list_workflows`) reports the weakest of theirs.",
    );
    const asked: Array<[string | null, string | null]> = [];
    const dir = await mkdtemp(join(tmpdir(), 'realm-docs-mcp-c1-'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(FLOW);
    await workflowStore.register(GATED);
    const server = createRealmMcpServer({
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore,
      // FLOW's project failed to load; GATED's resolved.
      disclosureProvider: async (definition, run) => {
        asked.push([definition?.id ?? null, run?.id ?? null]);
        const failed = definition?.id === FLOW.id;
        return buildDisclosureSet({
          env: {},
          declared: {},
          declaredState: failed ? 'unknown' : 'resolved',
          ...(failed ? { declaredCause: 'load_failed' as const } : {}),
          audience: 'agent',
        }).set;
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-729-c1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> })
          .content[0]!.text,
      ) as Record<string, unknown>;
    const receipt = (r: Record<string, unknown>) =>
      r['disclosure'] as { declared: string; declared_cause?: string; question?: string };
    const gated = await call('start_run', { workflow_id: GATED.id, params: {} });
    const run = await call('start_run', { workflow_id: FLOW.id, params: {} });
    asked.length = 0;
    const state = await call('get_run_state', { run_id: run['run_id'] as string });
    const fromState = [...asked];
    const listed = await call('list_workflows', {});
    // (a) red when a reply reports another workflow's standing, a list reports one workflow's,
    //     the question flag is dropped, or the provider is not given the workflow and the run;
    //     (b) prints states, causes, flags and the ids the provider was given.
    expect({
      gated: [receipt(gated).declared, receipt(gated).question],
      run: [receipt(run).declared, receipt(run).declared_cause],
      state: [receipt(state).declared, receipt(state).declared_cause],
      listed: [receipt(listed).declared, receipt(listed).declared_cause],
      providerGot: fromState.some(([w, r]) => w === FLOW.id && r === state['run_id']),
    }).toEqual({
      gated: ['resolved', 'declared_only'],
      run: ['unknown', 'load_failed'],
      state: ['unknown', 'load_failed'],
      listed: ['unknown', 'load_failed'],
      providerGot: true,
    });
  });
});

describe('#729 PR-3 correction 2 (G1) — the pages hold on the first call of a fresh process', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a server given no run store reports, on its first call, the standing of the project the run is about, and the provider gets that run', async () => {
    claim(
      CONNECT_PAGE,
      '`declared` says whether Realm knew the secrets declared by the deployment manifest of the project the reply is about:',
    );
    claim(
      TOOLS_PAGE,
      '`declared` is about the workflow the reply is about; a reply about several, such as `list_workflows`, gives the weakest.',
    );
    claim(
      LIBRARY_PAGE,
      'A function given the workflow a reply is about (or `undefined`) and, when the call names a run, that run;',
    );
    claim(
      'CHANGELOG.md',
      '`disclosureProvider(definition, run?)` returns the set a reply about that workflow, and that run when the call names one, is masked with',
    );
    // The default run store, under a HOME of this cell's own.
    const home = await mkdtemp(join(tmpdir(), 'realm-docs-mcp-c2-'));
    vi.stubEnv('HOME', home);
    const workflowStore = new JsonWorkflowStore(join(home, 'wf'));
    await workflowStore.register(FLOW);
    const runId = (
      await new JsonFileStore(join(home, '.realm', 'runs')).create({
        workflowId: FLOW.id,
        workflowVersion: 1,
        params: {},
      })
    ).run.id;
    const asked: Array<string | null> = [];
    const server = createRealmMcpServer({
      workflowStore,
      // FLOW's project failed to load.
      disclosureProvider: async (definition, run) => {
        asked.push(run?.id ?? null);
        const failed = definition?.id === FLOW.id;
        return buildDisclosureSet({
          env: {},
          declared: {},
          declaredState: failed ? 'unknown' : 'resolved',
          ...(failed ? { declaredCause: 'load_failed' as const } : {}),
          audience: 'agent',
        }).set;
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-729-c2', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const first = JSON.parse(
      (
        (await client.callTool({ name: 'get_run_state', arguments: { run_id: runId } })) as {
          content: Array<{ text: string }>;
        }
      ).content[0]!.text,
    ) as { disclosure: { declared: string; declared_cause?: string } };
    // (a) red when the server's run store does not reach the masking (no run: the reply is about no
    //     project and the provider is asked about none); (b) prints the standing and a boolean.
    expect({
      first: [first.disclosure.declared, first.disclosure.declared_cause ?? null],
      providerGotTheRun: asked.includes(runId),
    }).toEqual({ first: ['unknown', 'load_failed'], providerGotTheRun: true });
  });
});

describe("#729 PR-3 correction 3 (H-11') — a reply under a failed or changed manifest", () => {
  it('its values print as their type and size, its question is withheld, and its receipt says both', async () => {
    claim(
      TOOLS_PAGE,
      "When `declared_cause` is `load_failed` or `manifest_changed`, the reply's values are shown as their type and size, its question reads `withheld (declared values could not be read)` or `withheld (declared values changed)`, and the receipt adds `values: withheld` and `question: withheld`.",
    );
    // #729 PR-3 correction 5 (J-6): the receipt's `shaped`, documented.
    claim(
      TOOLS_PAGE,
      'When the reply shows a value as its type and size, `shaped` lists where each one is.',
    );
    claim(
      CONNECT_PAGE,
      'When Realm cannot read the declared secrets, because the manifest cannot be read (`load_failed`) or changed since the run recorded it (`manifest_changed`), the reply shows its values as their type and size and its question as `withheld (…)`, and says `values: withheld` and `question: withheld`.',
    );
    claim(
      'CHANGELOG.md',
      "an MCP reply's `disclosure` then says `values: withheld` and `question: withheld`.",
    );
    const ASKED: WorkflowDefinition = {
      id: 'docs-asked',
      name: 'asked',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        g: {
          description: 'G.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'], message: 'Approve {{ run.params.k }}?' },
        },
      },
    } as WorkflowDefinition;
    const replyFor = async (cause: 'manifest_changed' | 'load_failed') => {
      const dir = await mkdtemp(join(tmpdir(), 'realm-docs-mcp-c3-'));
      const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
      await workflowStore.register(ASKED);
      const server = createRealmMcpServer({
        runStore: new JsonFileStore(join(dir, 'runs')),
        workflowStore,
        disclosureProvider: async () =>
          buildDisclosureSet({
            env: {},
            declared: {},
            declaredState: cause === 'manifest_changed' ? 'partial' : 'unknown',
            declaredCause: cause,
            audience: 'agent',
          }).set,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'docs-c3', version: '0' });
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        const raw = (await client.callTool({
          name: 'start_run',
          arguments: { workflow_id: 'docs-asked', params: { k: 'FAKEvalue0729' } },
        })) as { content: Array<{ text: string }> };
        const body = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
        const runId = body['run_id'] as string;
        const stateRaw = (await client.callTool({
          name: 'get_run_state',
          arguments: { run_id: runId },
        })) as { content: Array<{ text: string }> };
        const state = JSON.parse(stateRaw.content[0]!.text) as Record<string, unknown>;
        const receipt = state['disclosure'] as Record<string, unknown>;
        return {
          params: state['params'],
          question: (state['pending_gate'] as { resolved_message?: string }).resolved_message,
          receipt: [receipt['values'], receipt['question']],
          shaped: receipt['shaped'],
        };
      } finally {
        await client.close();
      }
    };
    // (a) red when a reply under either cause walks its values or shows its question, or its receipt
    //     drops `shaped` (the paths it showed as their type and size); (b) prints the params' shape,
    //     the question sentence, the receipt's two fields and the shaped paths.
    expect({
      changed: await replyFor('manifest_changed'),
      failed: await replyFor('load_failed'),
    }).toEqual({
      changed: {
        params: { k: '‹string, 13 characters›' },
        question: 'withheld (declared values changed)',
        receipt: ['withheld', 'withheld'],
        shaped: ['pending_gate.preview', 'params'],
      },
      failed: {
        params: { k: '‹string, 13 characters›' },
        question: 'withheld (declared values could not be read)',
        receipt: ['withheld', 'withheld'],
        shaped: ['pending_gate.preview', 'params'],
      },
    });
  });
});
