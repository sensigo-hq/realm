// ways-view.ts — test support for #729 PR-0: a core reply read the way a door that serves the agent
// reads it, so a core test pins the reply's DATA (its progress ways, its D-8 word) without a
// door's words. Never imported by production code.
import { agentActionOf, agentRenderedList, narrowForDoor, DOOR_SERVES } from '../engine/ways.js';
import { TERMINAL_PHASES } from '../engine/lifecycle.js';
import type { EngineReply } from '../types/response-envelope.js';
import type { AgentAction } from '../types/workflow-error.js';

/** What these helpers read: a reply, or the ways composed from a record (`composeWaysAt`). */
type WaysOf = Pick<EngineReply, 'ways' | 'unavailable' | 'basis'>;

/** The narrowing of a reply for a door that serves the agent and the asked person (MCP's default). */
function narrowedForAgent(reply: WaysOf) {
  return reply.basis === undefined
    ? undefined
    : narrowForDoor(
        { ways: reply.ways, unavailable: reply.unavailable, basis: reply.basis },
        {
          door: 'test-agent-door',
          serves: DOOR_SERVES.mcp,
          route: 'test',
          source: { kind: 'default', ref: 'test' },
        },
      );
}

/**
 * The progress ways an agent may call on a reply, in the door's order — its steps, the answer, the
 * act — each as `run_step:<step>`, `respond` or `advance`.
 */
export function nextCalls(reply: WaysOf): string[] {
  const narrowed = narrowedForAgent(reply);
  if (narrowed === undefined) return [];
  const rank = (verb: string): number => (verb === 'run_step' ? 0 : verb === 'respond' ? 1 : 2);
  return narrowed.ways
    .filter(
      (w) =>
        (w.verb === 'run_step' || w.verb === 'respond' || w.verb === 'advance') &&
        w.for.includes('agent'),
    )
    .sort((a, b) => rank(a.verb) - rank(b.verb))
    .map((w) =>
      w.verb === 'run_step' ? `run_step:${w.step}` : w.verb === 'respond' ? 'respond' : 'advance',
    );
}

/** The agent's action word on a reply, as an agent-serving door derives it (D-8, T-22). */
export function agentActionFor(reply: EngineReply): AgentAction | undefined {
  const narrowed = narrowedForAgent(reply);
  const ended = reply.run_phase !== undefined && TERMINAL_PHASES.has(reply.run_phase);
  return agentActionOf(
    reply.intrinsic_action,
    reply.reply_kind,
    agentRenderedList(narrowed ?? { ways: [], unavailable: [] }, ended),
  );
}

/** The steps the reply's `advance` way says the engine owes (a due expiry as `expiry:<gate_id>`). */
export function owedOf(reply: Pick<EngineReply, 'ways'>): string[] | undefined {
  const advance = reply.ways.find((w) => w.verb === 'advance');
  if (advance === undefined || advance.verb !== 'advance') return undefined;
  return advance.owed.map((o) => ('expiry' in o ? `expiry:${o.expiry.gate_id}` : o.step));
}

/**
 * The claim token the reply hands out — its one carrier, the opening reply's `respond` way's
 * `proof` (A-17). Undefined on every other reply. A cell compares it for presence or equality,
 * never prints it.
 */
export function proofOf(reply: Pick<EngineReply, 'ways'>): string | undefined {
  const respond = reply.ways.find((w) => w.verb === 'respond');
  return respond !== undefined && respond.verb === 'respond'
    ? respond.proof?.claim_token
    : undefined;
}
