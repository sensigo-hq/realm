// refusal-routing-625.test.ts — issue #625 PR-2a, decision C94: a step `executeStep` refuses before
// its claim — a failed precondition or an invalid `trust`, an agent step or an `auto` step — tells
// its caller what it can call instead, from the run's view: its ways are the view's (which
// never offers a step refused before its claim, decisions C13/C82), `blocked_reason.eligible_steps`
// names the steps that can be called now (never the refused one), and the agent's word (D-8) is
// `resolve_precondition` when there is something to call, `report_to_user` when there is not.
// #729 PR-0: the reply's DATA is pinned here (its ways, read for the agent's door; its refusal's
// facts); the words the MCP door prints for it are pinned in mcp-server's render-reply.test.ts.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep, type StepDispatcher } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { EngineReply } from '../types/response-envelope.js';
import { agentActionFor, nextCalls } from '../test-support/ways-view.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });

const PRECONDITION: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const TRUST = { trust: 'human_confirm' } as unknown as Partial<StepDefinition>;

/** `refused` (shaped by `check`, of `kind`), with a ready agent step `ready` beside it when asked. */
function def(
  kind: 'agent' | 'auto',
  check: Partial<StepDefinition>,
  beside: 'agent' | 'auto' | 'none',
): WorkflowDefinition {
  return {
    id: `rr-${kind}-${beside}`,
    name: 'refusal routing',
    version: 1,
    steps: {
      refused: {
        description: 'Refused.',
        execution: kind,
        depends_on: [],
        ...check,
      } as StepDefinition,
      ...(beside !== 'none'
        ? { ready: { description: 'Ready.', execution: beside, depends_on: [] } as StepDefinition }
        : {}),
    },
  };
}

/** The reply's routing, in one object: what to do, what to call, what can be called. */
function routing(reply: EngineReply) {
  return {
    status: reply.status,
    agent_action: agentActionFor(reply),
    next: nextCalls(reply),
    eligible_steps: reply.blocked_reason?.eligible_steps,
  };
}

describe('#625 PR-2a, C94 — a refusal before the claim says what can be called instead', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-rr-625-')));
  });

  async function callRefused(d: WorkflowDefinition): Promise<EngineReply> {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    return executeStep(store, d, {
      runId: run.id,
      command: 'refused',
      input: {},
      dispatcher: echo,
    });
  }

  for (const kind of ['agent', 'auto'] as const) {
    it(`precondition, ${kind} step beside a ready agent step: resolve_precondition, the ready step, never the refused one`, async () => {
      const reply = await callRefused(def(kind, PRECONDITION, 'agent'));
      // (a) red when next_actions stay [], the refused step is listed, or `stop` comes back;
      // (b) prints the routing.
      expect(routing(reply)).toEqual({
        status: 'blocked',
        agent_action: 'resolve_precondition',
        next: ['run_step:ready'],
        eligible_steps: ['ready'],
      });
      // (a) red when the refusal's own hint or detail moves; (b) prints them.
      expect(reply.context_hint).toBe("Precondition failed for step 'refused'.");
      expect(reply.refusal?.code).toBe('refused_before_claim');
      expect(
        reply.refusal?.code === 'refused_before_claim' ? reply.refusal.facts.precondition : null,
      ).toEqual({ expression: 'run.params.ok == true', value: 'undefined' });
    });

    it(`trust, ${kind} step beside a ready agent step: resolve_precondition, the ready step; the refusal stays an error with its code`, async () => {
      const reply = await callRefused(def(kind, TRUST, 'agent'));
      // (a) red when the trust member keeps `next_actions: []` or lists itself; (b) prints the routing.
      expect(routing(reply)).toEqual({
        status: 'error',
        agent_action: 'resolve_precondition',
        next: ['run_step:ready'],
        eligible_steps: ['ready'],
      });
      // (a) red when the code changes; (b) prints it.
      expect(reply.error_code).toBe('VALIDATION_TRUST_VALUE');
    });

    it(`precondition, ${kind} step, nothing else can run: report_to_user, nothing to call`, async () => {
      const reply = await callRefused(def(kind, PRECONDITION, 'none'));
      // (a) red when `resolve_precondition` (or `stop`) is chosen with nothing to call; (b) prints it.
      expect(routing(reply)).toEqual({
        status: 'blocked',
        agent_action: 'report_to_user',
        next: [],
        eligible_steps: [],
      });
    });

    it(`trust, ${kind} step, nothing else can run: report_to_user, nothing to call`, async () => {
      const reply = await callRefused(def(kind, TRUST, 'none'));
      // (a) red when the trust member chooses another action; (b) prints the routing.
      expect(routing(reply)).toEqual({
        status: 'error',
        agent_action: 'report_to_user',
        next: [],
        eligible_steps: [],
      });
    });
  }

  it('precondition, beside a ready AUTO step: the advance_run act, and the auto step as the one that can be called', async () => {
    const reply = await callRefused(def('auto', PRECONDITION, 'auto'));
    // (a) red when the act is dropped, or the auto step is left out of eligible_steps; (b) prints it.
    expect(routing(reply)).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      next: ['advance'],
      eligible_steps: ['ready'],
    });
  });

  it('a step not eligible now: eligible_steps names the steps that can be called, never a refused one', async () => {
    const d: WorkflowDefinition = {
      id: 'rr-not-eligible',
      name: 'refusal routing',
      version: 1,
      steps: {
        a: {
          description: 'A.',
          execution: 'agent',
          depends_on: [],
          ...PRECONDITION,
        } as StepDefinition,
        b: { description: 'B.', execution: 'agent', depends_on: [] },
        c: { description: 'C.', execution: 'agent', depends_on: ['a'] },
      },
    };
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'c',
      input: {},
      dispatcher: echo,
    });
    // (a) red when eligible_steps lists `a` (eligible on the record, refused before its claim);
    // (b) prints the routing.
    expect(routing(reply)).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      next: ['run_step:b'],
      eligible_steps: ['b'],
    });
  });
});
