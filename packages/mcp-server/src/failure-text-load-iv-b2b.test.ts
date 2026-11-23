// failure-text-load-iv-b2b.test.ts — gap 2, unit (iv-b2b): the failure-text setting when a program
// embedding the server (`createRealmMcpServer`) hands it providers of its own.
//
// A program's `registryProvider` loads the program's own code for each workflow; its `priceSourceProvider`
// prices a run. When either throws a plain error, the text can be the program's data (a card number,
// a customer). Under `failureText: 'hidden'` the server shows its length in its place: in the reply's
// `errors[0]`, in `get_run_state`'s load warning and in `not_priced[].detail`; the code, the action and
// what to do next stay. A `WorkflowError` the provider throws is a typed refusal and stays, and so do
// Realm's own refusals (a registry of another release) and a workflow store's error. The cells run the
// real server in process (`createRealmMcpServer` over `InMemoryTransport`) on a temp home's stores.
// (The CLI's own providers, with the project's code really failing to load, are in the CLI's
// `failure-text-load-iv-b2b.test.ts`.) Every assertion carries (a) the change that turns it red and
// (b) what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  WorkflowError,
  createRealmBrand,
  type PriceSource,
  type RunRecord,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { createRealmMcpServer, type RealmMcpServerOptions } from './server.js';
import { makeTempHome, seedRun, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** A fake string no masking pattern catches (an email would be masked by pattern under shown too). */
const WORDS = 'Config for card 4111-1111-1111-1111 missing';
const CARD = '4111-1111-1111-1111';
const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;

const WF: WorkflowDefinition = {
  id: 'b2b-wf',
  name: 'b2b-wf',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'S.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

type Reply = Record<string, unknown> & {
  errors?: string[];
  error_code?: string;
  agent_action?: string;
  context_hint?: string;
  warnings?: string[];
  disclosure?: Record<string, unknown>;
};

/** One model request, priced by the installed list's shape; on a step and on a failed drive. */
const REQUEST = {
  request_index: 0,
  request_start: '2026-11-22T00:00:00.000Z',
  model: 'claude-x-20260101',
  prompt_tokens: 100,
  output_tokens: 1,
};

/** A run of `WF` whose step made a model call, in `phase`; with `driveFailed`, its drive failed once
 *  (that failure's own message is a failure's words too, shaped by unit (iv-b1)). */
function pricedRun(id: string, phase: 'running' | 'completed', driveFailed = true): RunRecord {
  const run = {
    id,
    workflow_id: WF.id,
    workflow_version: 1,
    params: {},
    version: 1,
    completed_steps: phase === 'completed' ? ['s'] : [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: phase,
    terminal_state: phase === 'completed',
    created_at: '2026-11-22T00:00:00.000Z',
    updated_at: '2026-11-22T00:00:01.000Z',
    evidence: [
      {
        step_id: 's',
        kind: 'execution',
        status: 'success',
        started_at: '2026-11-22T00:00:00.000Z',
        completed_at: '2026-11-22T00:00:01.000Z',
        duration_ms: 1,
        input_summary: {},
        output_summary: {},
        evidence_hash: 'b2b-s',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { state: 'engaged', basis: 'provider_reported', requests: [REQUEST] },
        },
      },
    ],
    drive_failures: {
      first_failed_at: '2026-11-22T00:00:02.000Z',
      total: 1,
      entries: [
        {
          at: '2026-11-22T00:00:02.000Z',
          step: 's',
          provider: 'anthropic',
          error_class: 'other',
          message: 'connection reset',
          elapsed_ms: 1,
          usage: [REQUEST],
        },
      ],
    },
  };
  if (!driveFailed) delete (run as { drive_failures?: unknown }).drive_failures;
  return run as unknown as RunRecord;
}

/** A temp home with `WF` registered, and a server over it per setting with the options given. */
async function world() {
  const h = await makeTempHome();
  homes.push(h);
  await h.stores.workflowStore.register(WF);
  const connect = async (
    failureText: 'shown' | 'hidden' | undefined,
    options: Partial<RealmMcpServerOptions>,
  ) => {
    const server = createRealmMcpServer({
      ...h.stores,
      ...options,
      ...(failureText !== undefined ? { failureText } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'failure-text-iv-b2b', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string }>;
      };
      const text = raw.content[0]?.text ?? '{}';
      return { text, reply: JSON.parse(text) as Reply };
    };
  };
  /** The same call through each setting. */
  const each = async (
    options: Partial<RealmMcpServerOptions>,
    name: string,
    args: Record<string, unknown>,
  ) => ({
    hidden: await (await connect('hidden', options))(name, args),
    shown: await (await connect('shown', options))(name, args),
    unset: await (await connect(undefined, options))(name, args),
  });
  return { h, each };
}

const receiptOf = (r: Reply) => (r.disclosure ?? {}) as Record<string, unknown>;

/** A `get_run_state` reply's text without what only the read's own time sets (`as_of`, `idle_ms`):
 *  the temp home's store reads the real clock, so two reads differ there and nowhere else. */
const steady = (text: string): string =>
  JSON.stringify(JSON.parse(text), (key: string, value: unknown) =>
    key === 'as_of' || key === 'idle_ms' ? undefined : value,
  );

/** An embedder's provider that throws `thrown` for every workflow. */
const throwing = (thrown: unknown) => async (): Promise<ExtensionRegistry> => {
  throw thrown;
};

const typedRefusal = (): WorkflowError =>
  new WorkflowError(WORDS, {
    code: 'VALIDATION_WORKFLOW_SCHEMA',
    category: 'VALIDATION',
    agentAction: 'report_to_user',
    retryable: false,
  });

describe("gap 2 (iv-b2b), check 2 — an embedder's own registryProvider", () => {
  it('a plain Error it throws: errors[0] its shape; the code, the action and the hint as under shown; shown equals no setting', async () => {
    const w = await world();
    const { hidden, shown, unset } = await w.each(
      { registryProvider: throwing(new Error(WORDS)) },
      'start_run',
      { workflow_id: WF.id },
    );
    // (a) red when the server does not judge its provider's throw (the rule removed: an unmarked
    //     plain throw from a provider that is not Realm's own stays); (b) prints both replies' fields.
    expect({
      words: hidden.text.includes(CARD),
      error: hidden.reply.errors?.[0],
      code: hidden.reply.error_code,
      action: hidden.reply.agent_action,
      hint: hidden.reply.context_hint,
      word: receiptOf(hidden.reply)['failure_text'],
      paths: receiptOf(hidden.reply)['shaped'],
    }).toEqual({
      words: false,
      error: shape(WORDS.length),
      code: shown.reply.error_code,
      action: shown.reply.agent_action,
      hint: shown.reply.context_hint,
      word: 'withheld',
      paths: ['errors'],
    });
    // (a) red when shown shapes too, or the call never reached the provider; (b) prints the shown
    //     reply's first error and whether the two texts differ.
    expect({ first: shown.reply.errors?.[0], same: shown.text === unset.text }).toEqual({
      first: WORDS,
      same: true,
    });
  });

  it('a WorkflowError it throws: stays as written under hidden, byte for byte, no receipt word', async () => {
    const w = await world();
    const { hidden, shown } = await w.each(
      { registryProvider: throwing(typedRefusal()) },
      'start_run',
      {
        workflow_id: WF.id,
      },
    );
    // (a) red when an embedder's WorkflowError is marked as a failure's words; (b) prints both
    //     replies' first error, code and the receipt's word.
    expect({
      same: hidden.text === shown.text,
      first: hidden.reply.errors?.[0],
      code: hidden.reply.error_code,
      word: receiptOf(hidden.reply)['failure_text'],
    }).toEqual({ same: true, first: WORDS, code: 'VALIDATION_WORKFLOW_SCHEMA', word: undefined });
  });
});

/** Every `not_priced` entry in `node`, at any depth, in document order. */
function notPricedOf(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(notPricedOf);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    key === 'not_priced' && Array.isArray(child)
      ? (child as Array<Record<string, unknown>>)
      : notPricedOf(child),
  );
}

describe('gap 2 (iv-b2b), check 3 — not_priced[].detail', () => {
  it("an embedder's price provider throws a plain Error: every carrier's detail its shape, cause and count kept, the paths in the receipt", async () => {
    const w = await world();
    await seedRun(w.h.stores.runStore, pricedRun('b2b-priced', 'running'));
    const priceSourceProvider = async (): Promise<PriceSource> => {
      throw new Error(WORDS);
    };
    const { hidden, shown, unset } = await w.each(
      { registry: new ExtensionRegistry(), priceSourceProvider },
      'get_run_state',
      { run_id: 'b2b-priced', include_steps: true },
    );
    const shownEntries = notPricedOf(shown.reply);
    // (a) red when priceSourceFor does not judge the embedder's throw (the detail left whole), or
    //     shapes by `cause` alone; (b) prints the entries, the receipt's word and paths.
    expect({
      words: hidden.text.includes(CARD),
      entries: notPricedOf(hidden.reply),
      word: receiptOf(hidden.reply)['failure_text'],
      paths: receiptOf(hidden.reply)['shaped'],
    }).toEqual({
      words: false,
      entries: shownEntries.map((e) => ({ ...e, detail: shape(WORDS.length) })),
      word: 'withheld',
      // The failed drive's own message, and the run-health reason that quotes it, are (iv-b1)'s.
      paths: [
        'drive_failures.entries[0].message',
        'run_health[0].reason',
        'steps',
        'drive_failure_costs[0].cost',
        'run_cost.total.not_priced[0].detail',
      ],
    });
    // (a) red when the fixture prices nothing at all, or shown shapes too; (b) prints the shown
    //     entries' causes and details, and whether shown equals no setting.
    expect({
      carriers: shownEntries.length >= 3,
      causes: [...new Set(shownEntries.map((e) => e['cause']))],
      details: [...new Set(shownEntries.map((e) => e['detail']))],
      same: steady(shown.text) === steady(unset.text),
    }).toEqual({
      carriers: true,
      causes: ['economics_unreachable'],
      details: [WORDS],
      same: true,
    });
  });

  it("Realm's own economics_unreachable sentence stays (the run's workflow copy could not be read)", async () => {
    const w = await world();
    await seedRun(w.h.stores.runStore, {
      ...pricedRun('b2b-orphan', 'running', false),
      workflow_id: 'b2b-gone',
    } as RunRecord);
    const priceSourceProvider = async (): Promise<PriceSource> => {
      throw new Error(WORDS);
    };
    const { hidden, shown } = await w.each(
      { registry: new ExtensionRegistry(), priceSourceProvider },
      'get_run_state',
      { run_id: 'b2b-orphan', include_steps: true },
    );
    // (a) red when every economics_unreachable detail is shaped (by cause alone); (b) prints the
    //     details under hidden and whether the two replies differ.
    expect({
      details: [...new Set(notPricedOf(hidden.reply).map((e) => e['detail']))],
      same: steady(hidden.text) === steady(shown.text),
    }).toEqual({
      details: ["the run's workflow copy could not be read, so its deployment root is unknown"],
      same: true,
    });
  });
});

describe("gap 2 (iv-b2b), check 4 — Realm's words and a store's error stay", () => {
  it('a registry of another release (ENGINE_RELEASE_LINE_MISMATCH, refused after the provider returns): byte for byte, no receipt word', async () => {
    const w = await world();
    const other = {};
    Object.defineProperty(other, Symbol.for('@sensigo/realm/ExtensionRegistry'), {
      value: createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/'),
    });
    const { hidden, shown } = await w.each(
      { registryProvider: async () => other as ExtensionRegistry },
      'start_run',
      { workflow_id: WF.id },
    );
    // (a) red when the refusal is shaped; (b) prints the code, whether the replies differ, the word.
    expect({
      code: hidden.reply.error_code,
      same: hidden.text === shown.text,
      word: receiptOf(hidden.reply)['failure_text'],
    }).toEqual({ code: 'ENGINE_RELEASE_LINE_MISMATCH', same: true, word: undefined });
  });

  it('a workflow store that throws a plain Error: its words stay, byte for byte', async () => {
    const w = await world();
    const workflowStore = Object.assign(Object.create(w.h.stores.workflowStore) as object, {
      get: async () => {
        throw new Error(WORDS);
      },
    }) as unknown as WorkflowRegistrar;
    const { hidden, shown } = await w.each(
      { workflowStore, registryProvider: async () => new ExtensionRegistry() },
      'start_run',
      { workflow_id: WF.id },
    );
    // (a) red when every plain throw at the tools' catch is marked; (b) prints the first error,
    //     whether the replies differ and the receipt's word.
    expect({
      first: hidden.reply.errors?.[0],
      same: hidden.text === shown.text,
      word: receiptOf(hidden.reply)['failure_text'],
    }).toEqual({ first: WORDS, same: true, word: undefined });
  });
});

describe("gap 2 (iv-b2b), check 5 — get_run_state's load warning from an embedder's provider", () => {
  it('a plain Error: Realm’s sentence kept, the message its shape, `warnings` in the receipt; under shown the words and “no error code”', async () => {
    const w = await world();
    await seedRun(w.h.stores.runStore, pricedRun('b2b-warn', 'running', false));
    const { hidden, shown } = await w.each(
      { registryProvider: throwing(new Error(WORDS)) },
      'get_run_state',
      { run_id: 'b2b-warn' },
    );
    const warningOf = (r: Reply) =>
      (r.warnings ?? []).find((x) => x.startsWith('this server could not load the project code'));
    const head = `this server could not load the project code for workflow '${WF.id}' (no error code): `;
    const tail = '; no step can be run or advanced from this server until it loads.';
    // (a) red when the warning reads only the loader's mark (the embedder's throw left whole), or
    //     shapes under shown; (b) prints both warnings and the receipt.
    expect({
      hidden: warningOf(hidden.reply),
      shown: warningOf(shown.reply),
      word: receiptOf(hidden.reply)['failure_text'],
      paths: receiptOf(hidden.reply)['shaped'],
    }).toEqual({
      hidden: `${head}${shape(WORDS.length)}${tail}`,
      shown: `${head}${JSON.stringify(WORDS)}${tail}`,
      word: 'withheld',
      paths: ['warnings'],
    });
  });
});

describe('gap 2 (iv-b2b), check 8 — the words an embedder reads', () => {
  it("the run-state page says how a program's own registryProvider is judged", () => {
    // Executed by check 2 (a plain Error shaped, a WorkflowError kept) and check 5 (the warning).
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "A program's own `registryProvider` is judged the same way: a `WorkflowError` it throws stays as written, and anything else it throws shows as its shape.",
    );
  });

  it("RealmMcpServerOptions.registryProvider's comment, in the published types, says what hidden does to its throws", () => {
    const types = readFileSync(join(ROOT, 'packages/mcp-server/dist/server.d.ts'), 'utf8').replace(
      /\s*\*\s*/g,
      ' ',
    );
    // (a) red when the sentence is not in the built types an embedder's editor shows; (b) prints
    //     whether it is.
    expect(
      types.includes(
        'Under the failure-text setting `hidden`, a plain `Error` this provider throws shows to the assistant as its shape; a `WorkflowError` it throws stays as written.',
      ),
    ).toBe(true);
  });
});
