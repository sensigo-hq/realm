// filter-mask-fix.test.ts — the filter-mask fix, PR 1 (the MCP door). A value Realm hides, shown in a
// template through a filter (`| upper`), reached an MCP client in its filtered form: in a gate's
// question, in a `run_step` way's `prompt` (on `start_run`, `get_run_state` and the answer's reply),
// because the filters ran before the mask. And a span mark planted inside a value passed the reply's
// mask, because marks were stripped after it. Every fake here is made up for the test.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  compileDisclosure,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logMasked, MCP_ENVELOPE_TABLE, toolContentOf } from './render-reply.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');

const K = 'fm-mcp-declared-7f3e';
const E = 'fm-mcp-environment-91ac';
const MARK = String.fromCharCode(0xe000);
/** The declared fake with a span mark planted after its fifth character. */
const MARKED = `${K.slice(0, 5)}${MARK}${K.slice(5)}`;

const set = () =>
  compileDisclosure(
    [
      { value: K, source: 'declared:FM_K' },
      { value: E, source: 'env:FM_E' },
    ],
    { declared: 'resolved', audience: 'agent', environment: 'swept' },
  ).set;

const SHOWN = 'Upper: {{ run.params.k | upper }}\nPlain: {{ run.params.k }}';
const wf = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
/** A gate whose question shows the fake, then an agent step whose prompt shows it. */
const GATED = wf('fm-gated', {
  g: {
    description: 'G.',
    execution: 'auto',
    trust: 'human_confirmed',
    depends_on: [],
    gate: { choices: ['approve', 'reject'], message: `${SHOWN}\nEnv: {{ run.params.e | upper }}` },
  },
  a: {
    description: 'A.',
    execution: 'agent',
    depends_on: ['g'],
    prompt: `${SHOWN}\nEnv: {{ run.params.e | upper }}`,
  },
});
/** An agent step first: its prompt shows the fake. */
const AGENT = wf('fm-agent', {
  a: { description: 'A.', execution: 'agent', depends_on: [], prompt: SHOWN },
});
/** A gate step whose instructions (the opening reply's `gate.agent_hint`) show the fake. */
const HINT = wf('fm-hint', {
  g: {
    description: 'G.',
    execution: 'auto',
    trust: 'human_confirmed',
    depends_on: [],
    instructions: 'Hint: {{ run.params.k | upper }}',
    gate: { choices: ['approve'], message: 'Approve?' },
  },
});
/** An agent step whose prompt's fixed text holds a planted span mark. */
const MARKED_HEAD = wf('fm-marked-head', {
  a: {
    description: 'A.',
    execution: 'agent',
    depends_on: [],
    prompt: `Fixed${MARK} head. {{ run.params.k }}`,
  },
});
/** An agent step whose prompt opens with fixed text, then a run's value under a filter. */
const PLAIN_HEAD = wf('fm-plain-head', {
  a: {
    description: 'A.',
    execution: 'agent',
    depends_on: [],
    prompt: 'Fixed head. {{ run.params.k | upper }}',
  },
});

const handles: TempHome[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

async function connect() {
  const h = await makeTempHome();
  handles.push(h);
  for (const d of [GATED, AGENT, HINT, MARKED_HEAD, PLAIN_HEAD])
    await h.stores.workflowStore.register(d);
  const server = createRealmMcpServer({
    ...h.stores,
    gateAnswers: 'permitted',
    disclosureProvider: async () => set(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fm-fix', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return {
      text: raw.content[0]!.text,
      body: JSON.parse(raw.content[0]!.text) as Obj,
    };
  };
}

/** A JSON object of a reply. */
type Obj = Record<string, unknown>;
/** The value at `keys` under `value`, or `undefined` when a step of the path is not an object. */
const field = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (v, k) => (v !== null && typeof v === 'object' ? (v as Obj)[k] : undefined),
    value,
  );
/** The reply's next action that runs step `a` (its `execute_step` instruction names it). */
const actionOf = (body: Obj): Obj | undefined =>
  (body['next_actions'] as Obj[] | undefined)?.find(
    (n) => field(n, 'instruction', 'params', 'command') === 'a',
  );
/** That action's `prompt`. */
const promptOf = (body: Obj): string | undefined =>
  actionOf(body)?.['prompt'] as string | undefined;
/** Whether the fake shows in any case form. */
const leaks = (text: string): boolean =>
  [K, K.toUpperCase(), K.toLowerCase(), E.toUpperCase()].some((f) => text.includes(f));

describe('the filter-mask fix — the MCP door', () => {
  it('(1) a gate question showing the fake through `| upper` is the marker on the opening reply and on get_run_state', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: GATED.id, params: { k: K, e: E } });
    const runId = started.body['run_id'] as string;
    const state = await call('get_run_state', { run_id: runId });
    const question = (state.body['pending_gate'] as Record<string, string> | undefined)?.[
      'resolved_message'
    ];
    // (1) red when the gate site renders without the set: the question holds the upper-cased fake;
    //     (2) prints the stored question and whether either reply holds the fake in any case form.
    expect({
      question,
      // The environment value is shown in the question by design (the declared tier): set aside.
      startLeaks: leaks(started.text.replaceAll(E.toUpperCase(), '')),
      stateLeaks: leaks(state.text.replaceAll(E.toUpperCase(), '')),
    }).toEqual({
      question: `Upper: [REDACTED]\nPlain: [REDACTED]\nEnv: ${E.toUpperCase()}`,
      startLeaks: false,
      stateLeaks: false,
    });
  });

  it('(7) the question is at the declared tier (an environment value under `| upper` is shown, as today); the agent prompt masks it', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: GATED.id, params: { k: K, e: E } });
    const runId = started.body['run_id'] as string;
    const gateId = (
      (await call('get_run_state', { run_id: runId })).body['pending_gate'] as Record<
        string,
        string
      >
    )['gate_id'];
    const answered = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    // (1) red when the gate site masks at the door's tier (`all`: the question's env value hidden),
    //     or the prompt does not (the upper-cased env value sent); (2) prints both texts' env lines.
    expect({
      question: started.text.includes(`Env: ${E.toUpperCase()}`),
      prompt: promptOf(answered.body)?.split('\n')[2],
    }).toEqual({ question: true, prompt: 'Env: [REDACTED]' });
  });

  it('(3b) the answer’s reply offers the next agent step with its prompt masked before its filters', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: GATED.id, params: { k: K, e: E } });
    const runId = started.body['run_id'] as string;
    const gateId = (
      (await call('get_run_state', { run_id: runId })).body['pending_gate'] as Record<
        string,
        string
      >
    )['gate_id'];
    const answered = await call('submit_human_response', {
      run_id: runId,
      gate_id: gateId,
      choice: 'approve',
    });
    // (1) red when `submitHumanResponse` composes the reply's ways without the door's set (the
    //     prompt holds the upper-cased fake); (2) prints the prompt and the leak check.
    expect({ prompt: promptOf(answered.body), leaks: leaks(answered.text) }).toEqual({
      prompt: 'Upper: [REDACTED]\nPlain: [REDACTED]\nEnv: [REDACTED]',
      leaks: false,
    });
  });

  it('(3) the `run_step` prompt on start_run and get_run_state is the marker; the receipt counts what the walk itself hid', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: AGENT.id, params: { k: K } });
    const state = await call('get_run_state', { run_id: started.body['run_id'] as string });
    const hidden = (body: Obj) =>
      (body['disclosure'] as { hidden: { declared: number } }).hidden.declared;
    // (1) red when a door composes the ways without its set (the upper-cased fake in the prompt);
    //     (2) prints both prompts and both receipts' declared counts. The counts are lower than the
    //     base's by the prompt's plain placeholder: the renderer masked it upstream (constraint 3).
    expect({
      startPrompt: promptOf(started.body),
      statePrompt: promptOf(state.body),
      startHidden: hidden(started.body),
      stateHidden: hidden(state.body),
    }).toEqual({
      startPrompt: 'Upper: [REDACTED]\nPlain: [REDACTED]',
      statePrompt: 'Upper: [REDACTED]\nPlain: [REDACTED]',
      // start_run's reply shows the fake only in the prompt, already masked: its walk hid nothing.
      // get_run_state's shows the run's params too, which the walk hides.
      startHidden: 0,
      stateHidden: 1,
    });
  });

  it('(3) start_run_batch: each started run’s `run_step` prompt is the marker', async () => {
    const call = await connect();
    const batch = await call('start_run_batch', {
      workflow_id: AGENT.id,
      items: [{ params: { k: K } }],
    });
    const started = (batch.body['started'] as Array<Obj>)[0]!;
    // (1) red when the batch composes its entries' ways without the door's set (the upper-cased
    //     fake); (2) prints the prompt and the leak check.
    expect({ prompt: promptOf(started), leaks: leaks(batch.text) }).toEqual({
      prompt: 'Upper: [REDACTED]\nPlain: [REDACTED]',
      leaks: false,
    });
  });

  it('(3b) a form answered in an `asked` session: the reply after the answer offers the next agent step with its prompt masked', async () => {
    const h = await makeTempHome();
    handles.push(h);
    await h.stores.workflowStore.register(GATED);
    const server = createRealmMcpServer({
      ...h.stores,
      gateAnswers: 'asked',
      disclosureProvider: async () => set(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'fm-forms', version: '0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    // The person answers the form: approve.
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'accept',
      content: { choice: 'approve' },
    }));
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({
      name: 'start_run',
      arguments: { workflow_id: GATED.id, params: { k: K, e: E } },
    })) as { content: Array<{ text: string }> };
    const body = JSON.parse(raw.content[0]!.text) as Obj;
    // (1) red when the form path composes its ways, or submits the answer, without the door's set
    //     (the upper-cased fake in the next step's prompt); (2) prints the prompt and the leak check.
    expect({ prompt: promptOf(body), leaks: leaks(raw.content[0]!.text) }).toEqual({
      prompt: 'Upper: [REDACTED]\nPlain: [REDACTED]\nEnv: [REDACTED]',
      leaks: false,
    });
  });

  it('(1, correction 1) a gate step’s instructions showing the fake through `| upper` reach the client as `gate.agent_hint`, masked', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: HINT.id, params: { k: K } });
    // (1) red when the instructions site renders without the set (the upper-cased fake in the
    //     hint); (2) prints the hint and the leak check.
    expect({ hint: field(started.body, 'gate', 'agent_hint'), leaks: leaks(started.text) }).toEqual(
      {
        // The door introduces the author's text as theirs.
        hint: "From the workflow's author: Hint: [REDACTED]",
        leaks: false,
      },
    );
  });

  it('(3) present_question: the form’s next `run_step` prompt is masked with the door’s set; the form’s question is the stored one, unchanged (the intended asymmetry)', async () => {
    const h = await makeTempHome();
    handles.push(h);
    await h.stores.workflowStore.register(GATED);
    const server = createRealmMcpServer({
      ...h.stores,
      gateAnswers: 'asked',
      disclosureProvider: async () => set(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'fm-present', version: '0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    // The first form (start_run's) is declined; the second (present_question's) is answered.
    const messages: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      messages.push(String((req.params as { message?: string }).message ?? ''));
      return messages.length === 1
        ? { action: 'decline' }
        : { action: 'accept', content: { choice: 'approve' } };
    });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const text = async (name: string, args: Record<string, unknown>): Promise<string> =>
      ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> })
        .content[0]!.text;
    const started = JSON.parse(
      await text('start_run', { workflow_id: GATED.id, params: { k: K, e: E } }),
    ) as Obj;
    const runId = started['run_id'] as string;
    const gateId = field(
      JSON.parse(await text('get_run_state', { run_id: runId })),
      'pending_gate',
      'gate_id',
    ) as string;
    const presented = await text('present_question', { run_id: runId, gate_id: gateId });
    // (1) red when present_question's form path composes its ways without the door's set (the
    //     upper-cased fake in the next step's prompt), or when the door's set re-masks the form's
    //     question (its environment value, shown at the declared tier, would be hidden); (2) prints
    //     the prompt, the form's question line and the leak check.
    expect({
      forms: messages.length,
      prompt: promptOf(JSON.parse(presented) as Obj),
      questionEnvLine: messages[1]!.split('\n').find((l) => l.startsWith('Env:')),
      leaks: leaks(presented),
    }).toEqual({
      forms: 2,
      prompt: 'Upper: [REDACTED]\nPlain: [REDACTED]\nEnv: [REDACTED]',
      questionEnvLine: `Env: ${E.toUpperCase()}`,
      leaks: false,
    });
  });

  it('(8) a declared value with a planted span mark is masked in the reply walk (the run’s params)', async () => {
    const call = await connect();
    const started = await call('start_run', { workflow_id: AGENT.id, params: { k: MARKED } });
    const state = await call('get_run_state', { run_id: started.body['run_id'] as string });
    // (1) red when the walk matches before it strips the marks (the marked fake passes as itself);
    //     (2) prints whether the replies hold the fake's halves.
    expect({
      startHolds: started.text.includes(K.slice(5)),
      stateHolds: state.text.includes(K.slice(5)),
    }).toEqual({ startHolds: false, stateHolds: false });
  });

  it('(8) the string tool reply and the masked log strip the marks before they mask', () => {
    vi.stubEnv('FM_LOG_E', E);
    const markedE = `${E.slice(0, 5)}${MARK}${E.slice(5)}`;
    const reply = toolContentOf(`refused: ${MARKED}`, {
      set: set(),
      audience: 'agent',
      table: MCP_ENVELOPE_TABLE,
    }).content[0]!.text;
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    logMasked(`failed with ${markedE}`);
    // (1) red when either masks before it strips (the marked value passes); (2) prints both texts
    //     with the mark shown as <U+E000>.
    expect({
      reply: reply.replace(MARK, '<U+E000>'),
      log: written.join('').replace(MARK, '<U+E000>'),
    }).toEqual({ reply: 'refused: [REDACTED]', log: 'failed with [REDACTED]\n' });
  });

  it('(9) a prompt whose fixed text holds a mark publishes no stable_prefix; an unmarked one publishes its head', async () => {
    const call = await connect();
    const marked = await call('start_run', { workflow_id: MARKED_HEAD.id, params: { k: K } });
    const plain = await call('start_run', { workflow_id: PLAIN_HEAD.id, params: { k: K } });
    const prefixOf = (body: Obj) => actionOf(body)?.['stable_prefix'];
    // (1) red when the door's leaf transform does not strip (the marked prompt publishes a prefix),
    //     or the unmarked prompt's head moves; (2) prints both prefixes.
    expect({ marked: prefixOf(marked.body), plain: prefixOf(plain.body) }).toEqual({
      marked: undefined,
      plain: {
        chars: 'Fixed head. '.length,
        unit: 'utf16',
        sha256: '8dc8b3b4694f08fb55e294349b29f4e9821290ed6b0e7345727cd5d0a8c75b07',
      },
    });
  });
  it('(correction 1, 2) the two pages say what the receipt’s `hidden` counts: this reply’s own mask, not a marker a template rendered', () => {
    const sought = [
      [
        'docs/reference/mcp/tools.md',
        "`hidden` (how many values were replaced with `[REDACTED]` by this reply's own mask, by kind: `declared`, `environment`, `pattern`; a value hidden before a template's filters ran (a step's prompt, a gate's instructions) shows its marker and is not counted here)",
      ],
      [
        'docs/guides/connect-an-mcp-client.md',
        "`hidden` counts what was replaced with `[REDACTED]` by this reply's own mask, by kind (a value hidden before a template's filters ran, in a step's prompt or a gate's instructions, shows its marker and is not counted here);",
      ],
    ] as const;
    // (1) red when either clause leaves its page or a word differs; (2) prints each page and found.
    expect(
      sought.map(([page, text]) => [
        page,
        flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(text)),
      ]),
    ).toEqual(sought.map(([page]) => [page, true]));
  });
});
