// no-run-state.ts — Q1 (#592) unit e1: the refusals whose `run_version: 0` names no run's state say,
// once per process, that the field is going away (REALM-D002, removal 0.52.0). The SET is fixed at
// the sites that call this: the six outer catches that build `buildPreExecutionErrorEnvelope(…, 0,
// …)`, `append_trace`'s catch when the error carried no version, `argsNumbersEnvelope` and
// `create_workflow`'s refusal envelope. Never a reply that carries the run's real version, and never
// a change to any reply: a deprecation is said on the door's error output (and, over the stdio
// server, the protocol's warning notification), not in the reply.
import { warnDeprecated } from '../deprecations.js';

/** Says REALM-D002 (once per process) and returns `value` unchanged. */
export function noRunState<T>(value: T): T {
  warnDeprecated('REALM-D002');
  return value;
}
