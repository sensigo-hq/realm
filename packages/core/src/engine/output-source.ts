// output-source.ts — issue #625 PR-2a, the last prompt's F4 (framework §5 E1, review A2-2, A3-8, A3-9): the
// one read of where an evidence entry's output came from — its `output_source` when it carries one,
// else WHY it has none, typed. A new record fact is readable on every entry: never an absence a reader
// has to guess at.
import type { EvidenceSnapshot, OutputSource } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

/**
 * Why an evidence entry carries no `output_source`, the first that holds, in this order (whether a
 * step is bare needs its definition, so the definition's absence is asked before bareness):
 *  - `not_an_output_entry`: the entry records no step output — a `gate_response` entry (the answer,
 *    or the expiry that settled the question) or the reclaim audit entry (`output_summary.reclaimed`);
 *  - `definition_unavailable`: the workflow given has no step by the entry's name (or none was given),
 *    so whether the step is bare cannot be said;
 *  - `not_a_bare_step`: the step has a handler or a service, or is not an `auto` step — its output is
 *    its own, and the field is never written for it;
 *  - `predates_output_source`: a bare `auto` step's entry written before the field existed.
 */
export const OUTPUT_SOURCE_ABSENT_CAUSES = [
  'not_an_output_entry',
  'definition_unavailable',
  'not_a_bare_step',
  'predates_output_source',
] as const;
export type OutputSourceAbsentCause = (typeof OUTPUT_SOURCE_ABSENT_CAUSES)[number];

/**
 * A BARE `auto` step: `execution: auto` with no handler and no service — the steps whose output the
 * caller or the engine supplies, and whose entry records where it came from. The one predicate the
 * execution path and {@link outputSourceOf} read.
 */
export function isBareAutoStep(step: StepDefinition | undefined): boolean {
  return (
    step?.execution === 'auto' && step.handler === undefined && step.uses_service === undefined
  );
}

/**
 * Where an evidence entry's output came from (F4): `{ source }` when the entry carries
 * `output_source`; otherwise `{ absent_cause }`, the first {@link OUTPUT_SOURCE_ABSENT_CAUSES} member
 * that holds. `definition` is the run's workflow, when the reader has it. `realm run inspect` renders
 * it; a reader of an export, which writes the record as stored, derives the absence with it too.
 */
export function outputSourceOf(
  entry: Pick<EvidenceSnapshot, 'step_id' | 'kind' | 'output_summary' | 'output_source'>,
  definition: Pick<WorkflowDefinition, 'steps'> | undefined,
): { source: OutputSource } | { absent_cause: OutputSourceAbsentCause } {
  if (entry.output_source !== undefined) return { source: entry.output_source };
  if (entry.kind === 'gate_response' || entry.output_summary?.['reclaimed'] === true) {
    return { absent_cause: 'not_an_output_entry' };
  }
  const step = definition?.steps[entry.step_id];
  if (step === undefined) return { absent_cause: 'definition_unavailable' };
  if (!isBareAutoStep(step)) return { absent_cause: 'not_a_bare_step' };
  return { absent_cause: 'predates_output_source' };
}
