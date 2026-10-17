// answer-facts.ts — #627 W (§5.8): how a gate answer arrived, read once. A door declares the route
// an answer came through (`answer.route`), the program that recorded it is `driven_by`, and on server
// doors the transport's principal is `principal`; this module holds the ONE reading of the route and
// the form's evidence, so the reply (`outcome.via`) and every reader name the same facts — or the
// record's own typed absence — in one vocabulary (R3).
import type {
  AnswerRouteAbsence,
  EvidenceSnapshot,
  PendingGate,
  Principal,
  PrincipalAbsence,
} from '../types/run-record.js';
import { PRINCIPAL_ABSENCES } from '../types/run-record.js';
import { readDrivenBy, type ActorAbsent, type Attributed } from './holder.js';

/** The renderer id of the MCP door's form (§5.2): what showed the question when its answer came by form. */
export const MCP_FORM_RENDERER = 'realm-mcp-form/1';

/**
 * #627 W (§5.2): the evidence of an answer given in a form — the route, the gate the form was for (the
 * gate-id fence: the door checks it against its own request state before recording), and what showed
 * it. V-1 extends THIS function with the frozen `view_digest`; W builds no digest.
 */
export function shownViewEvidence(
  pendingGate: Pick<PendingGate, 'gate_id'>,
  renderer: string,
): { route: 'mcp_form'; gate_id: string; shown: { renderer: string } } {
  return { route: 'mcp_form', gate_id: pendingGate.gate_id, shown: { renderer } };
}

/**
 * #627 W (§5.8, cells 6 and 29): the route a `gate_response` entry records, or why it names none —
 * `settled_by_expiry` for an expiry's entry (keyed on `resolution`), `route_not_declared` for an
 * answer whose library caller declared none, `recorded_without_route` for an entry with no route
 * (written before this field, or by an older binary after it — no claim about when). Total: a
 * malformed field reads as recorded without a route.
 */
export function answerViaOf(
  entry: Pick<EvidenceSnapshot, 'resolution' | 'answer'>,
): string | { absent: AnswerRouteAbsence } {
  if (entry.resolution !== undefined) return { absent: 'settled_by_expiry' };
  const answer: unknown = entry.answer;
  if (typeof answer !== 'object' || answer === null) return { absent: 'recorded_without_route' };
  if ((answer as { absent?: unknown }).absent === 'route_not_declared') {
    return { absent: 'route_not_declared' };
  }
  const route = (answer as { route?: unknown }).route;
  return typeof route === 'string' && route.length > 0
    ? route
    : { absent: 'recorded_without_route' };
}

/**
 * #627 W (§5.8): the principal an entry records, read totally — a known kind with its fields, a known
 * absence, else `undefined` (an entry written before the field, or a malformed one: nothing is said).
 */
export function principalOf(entry: Pick<EvidenceSnapshot, 'principal'>): Principal | undefined {
  const p: unknown = entry.principal;
  if (typeof p !== 'object' || p === null) return undefined;
  const kind = (p as { kind?: unknown }).kind;
  if (kind === 'api_key') {
    const id = (p as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? { kind: 'api_key', id } : undefined;
  }
  if (kind === 'shared_token') return { kind: 'shared_token' };
  const absent = (p as { absent?: unknown }).absent;
  return typeof absent === 'string' && (PRINCIPAL_ABSENCES as readonly string[]).includes(absent)
    ? { absent: absent as PrincipalAbsence }
    : undefined;
}

/**
 * #627 W (§5.8): the facts of how one answer arrived, read once from its `gate_response` entry, for
 * the operator's line (`realm run inspect`). Not part of `AnswerView`, which `get_run_state` publishes:
 * the principal renders on inspect only.
 */
export interface AnswerArrival {
  via: string | { absent: AnswerRouteAbsence };
  recorded_by: Attributed | ActorAbsent;
  client_prompt_requested: boolean;
  principal?: Principal;
}

/** The arrival facts of one answer entry. Total: a malformed field reads as its absence. */
export function answerArrivalOf(entry: unknown): AnswerArrival {
  const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const principal = principalOf(e as Pick<EvidenceSnapshot, 'principal'>);
  return {
    via: answerViaOf(e as Pick<EvidenceSnapshot, 'resolution' | 'answer'>),
    recorded_by: readDrivenBy(e as { driven_by?: unknown }),
    client_prompt_requested: e['client_prompt_requested'] === true,
    ...(principal !== undefined ? { principal } : {}),
  };
}
