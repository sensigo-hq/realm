// createGateResponder — auto-responds to open human gates in test scenarios.
import {
  submitHumanResponse,
  type RunStore,
  type WorkflowDefinition,
  type ResponseEnvelope,
  type ExtensionRegistry,
} from '@sensigo/realm';

/**
 * Auto-responds to any open human gate on the run.
 * Reads gate_id and step_name from run.pending_gate, looks up the choice in
 * gateResponses[step_name], defaults to 'approve'. Calls submitHumanResponse.
 *
 * @param registry Optional project extension registry. When resolving the gate COMPLETES the
 *   run, the engine drains the run's `complete`/`always` finalizers; pass the registry that
 *   carries the workflow's finalizer handlers so those run in tests (mirrors the production
 *   gate-resolution drivers). Omit it for gate-free / default-handler / finalizer-free
 *   workflows — behavior is identical to before.
 * @throws Error if run.pending_gate is undefined.
 */
export async function createGateResponder(
  store: RunStore,
  definition: WorkflowDefinition,
  runId: string,
  gateResponses: Record<string, string>,
  registry?: ExtensionRegistry,
): Promise<ResponseEnvelope> {
  const run = await store.get(runId);
  if (run.pending_gate === undefined) {
    throw new Error('createGateResponder: run has no pending gate');
  }
  const choice = gateResponses[run.pending_gate.step_name] ?? 'approve';
  return submitHumanResponse(store, definition, {
    runId,
    gateId: run.pending_gate.gate_id,
    choice,
    ...(registry !== undefined ? { registry } : {}),
  });
}
