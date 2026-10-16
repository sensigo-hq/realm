// reply-fields-registry-729.test.ts — issue #729 PR-0 (D3 A-13; the #385 disclosure-parity pattern,
// as `sealed-by-disclosure-parity.test.ts` writes it): every field PR-0 added to the engine's reply
// is ROUTED on the MCP door — published as data, rendered into another field, or withheld with a
// reason a reader can weigh — and the route is asserted on a real reply.
//
// THE TRIGGER: `satisfies Record<Added, Route>` below, where `Added` is every key of `EngineReply`
// that the reply did not have at 358d3c83. Add a field to `EngineReply` and this file stops
// compiling until someone routes it. (It fires against the BUILT core types — build, then typecheck.)
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: field
// names and booleans.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  executeStep,
  submitHumanResponse,
  type EngineReply,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { renderReply } from './render-reply.js';

/** The reply's keys at 358d3c83 (`ResponseEnvelope`), before PR-0. */
type Before =
  | 'command'
  | 'run_id'
  | 'run_version'
  | 'status'
  | 'data'
  | 'evidence'
  | 'warnings'
  | 'diagnostics'
  | 'errors'
  | 'error_code'
  | 'error_details'
  | 'agent_action'
  | 'retry_after'
  | 'context_hint'
  | 'run_phase'
  | 'next_actions'
  | 'blocked_reason'
  | 'gate'
  | 'chained_auto_steps'
  | 'adopted_own'
  | 'adopted_anonymous'
  | 'preserved_foreign'
  | 'settled_by_default'
  | 'defaulted_steps'
  | 'guards'
  | 'ended_by'
  | 'stopped_step'
  | 'answer_recorded'
  | 'gate_claim';

/** The fields PR-0 added to the reply. */
type Added = Exclude<keyof EngineReply, Before>;

type Route =
  | { mcp: 'published' }
  | { mcp: 'rendered'; into: readonly string[] }
  | { mcp: 'withheld'; reason: string };

/** Where each added field goes on the MCP door (Amendment 9's published set). */
const ROUTES = {
  ways: { mcp: 'rendered', into: ['next_actions', 'also'] },
  // the elsewhere entries, the hint's sentences, the action word (D-8) and an await's until
  unavailable: { mcp: 'rendered', into: ['elsewhere', 'context_hint', 'agent_action'] },
  basis: { mcp: 'published' },
  outcome: { mcp: 'published' },
  races: { mcp: 'published' },
  expiry: { mcp: 'published' },
  // `about` published as `error.about`; the remedy worded into the hint; typed facts as error_details
  error: { mcp: 'rendered', into: ['error', 'context_hint', 'error_details'] },
  intrinsic_action: {
    mcp: 'withheld',
    reason: "the action table's input; its rendering is agent_action (D-8)",
  },
  reply_kind: { mcp: 'withheld', reason: "the action table's input: what kind of reply it is" },
  refusal: {
    mcp: 'withheld',
    reason: "the call's own verdict; worded into context_hint and blocked_reason",
  },
  names_next: {
    mcp: 'withheld',
    reason: 'marks a reply whose hint says what comes next; the door appends that sentence',
  },
} as const satisfies Record<Added, Route>;

const AGENT: WorkflowDefinition = {
  id: 'registry',
  name: 'registry',
  version: 1,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'agent', depends_on: ['a'] },
  },
};

const GATED: WorkflowDefinition = {
  id: 'registry-gated',
  name: 'registry gated',
  version: 1,
  steps: {
    q: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: {
        choices: ['approve', 'reject'],
        timeout_seconds: 60,
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
  },
} as WorkflowDefinition;

/** Replies that carry every added field between them. */
async function replies(): Promise<EngineReply[]> {
  const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-registry-729-')));
  const { run } = await store.create({ workflowId: AGENT.id, workflowVersion: 1, params: {} });
  const ok = await executeStep(store, AGENT, {
    runId: run.id,
    command: 'a',
    input: {},
    dispatcher: async () => ({}),
  });
  const blocked = await executeStep(store, AGENT, {
    runId: run.id,
    command: 'a',
    input: {},
    dispatcher: async () => ({}),
  });
  const gated = await store.create({ workflowId: GATED.id, workflowVersion: 1, params: {} });
  await executeStep(store, GATED, {
    runId: gated.run.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({}),
  });
  const open = await store.get(gated.run.id);
  const late = await submitHumanResponse(store, GATED, {
    runId: gated.run.id,
    gateId: open.pending_gate!.gate_id,
    choice: 'reject',
    now: new Date(new Date(open.pending_gate!.expires_at!).getTime() + 5_000),
  });
  // A loop's race and a stop's `about` (their producers are pinned in core): carried by a reply.
  const raced = {
    ...ok,
    races: [{ step: 'b', kind: 'held_elsewhere', ran_here: false }],
    error: { remedy: [], about: 'g' },
  } as EngineReply;
  return [ok, blocked, late, raced];
}

describe('#729 PR-0 — A-13: every field PR-0 added to the reply is routed on the MCP door', () => {
  it('each route holds on a real reply: published as is, rendered into its field, or withheld with a reason', async () => {
    const found: string[] = [];
    const all = await replies();
    for (const [field, route] of Object.entries(ROUTES) as [Added, Route][]) {
      const carriers = all.filter((r) => r[field] !== undefined);
      if (carriers.length === 0) {
        found.push(`${field}: no reply here carries it`);
        continue;
      }
      for (const reply of carriers) {
        const env = renderReply(reply).envelope as Record<string, unknown>;
        if (route.mcp === 'published') {
          if (JSON.stringify(env[field]) !== JSON.stringify(reply[field])) {
            found.push(`${field}: published, but the envelope's differs`);
          }
        } else if (route.mcp === 'rendered') {
          if (field !== 'error' && field in env) found.push(`${field}: rendered, yet published`);
          if (!route.into.some((into) => env[into] !== undefined)) {
            found.push(`${field}: rendered, but none of ${route.into.join('/')} is there`);
          }
          if (field === 'error' && 'remedy' in ((env['error'] as object | undefined) ?? {})) {
            found.push('error: its remedy is published');
          }
        } else {
          if (field in env) found.push(`${field}: withheld, yet published`);
          if (route.reason.trim() === '') found.push(`${field}: withheld with no reason`);
        }
      }
    }
    // (a) red when a field leaves by another route than its row, a published field is reshaped, or
    //     a row loses its reason; (b) prints each field and how it went.
    expect(found).toEqual([]);
  });
});
