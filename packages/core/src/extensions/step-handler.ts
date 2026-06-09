// Step handler — custom business logic for a workflow step.

export interface StepHandlerInputs {
  params: Record<string, unknown>;
}

export interface StepContext {
  run_id: string;
  run_params: Record<string, unknown>;
  config: Record<string, unknown>;
  /**
   * Outputs from prior steps in the run, keyed by step_id.
   * Use this to access document text, extracted candidates, or any data
   * produced by earlier auto or agent steps in the same run.
   */
  resources?: Record<string, unknown>;
}

export interface StepHandlerResult {
  /**
   * Output data to record in the evidence chain. Required unless `abort` is set.
   * When both `abort` and `data` are present, `abort` takes precedence and `data` is ignored.
   */
  data?: Record<string, unknown>;
  // TODO: not yet consumed by the engine — reserved for future use.
  state_update?: Record<string, unknown>;
  /**
   * When set, the engine transitions the run to run_phase: 'aborted'. The step is added to
   * completed_steps (not failed_steps) and all downstream steps are skipped. Use for expected
   * business conditions (e.g. "ticket is already closed") that should stop the run cleanly.
   *
   * Mutually exclusive with `warn` — when both are present, `abort` takes precedence.
   */
  abort?: { message: string };
  /**
   * When set, the step completes normally but the engine records a warning.
   * The warning appears in EvidenceSnapshot.warn and ResponseEnvelope.warnings[].
   * Returning warn is unconditionally final — the retry loop does not retry a warned result.
   * Mutually exclusive with abort.
   */
  warn?: { message: string };
}

export interface StepHandler {
  readonly id: string;
  /**
   * Step IDs this handler reads from `context.resources`.
   * When declared, the YAML loader verifies that each listed step ID exists in
   * the workflow definition at registration time.
   *
   * Purely informational at runtime — the engine does not enforce or filter
   * `context.resources` based on this list.
   */
  readonly uses_resources?: readonly string[];
  /**
   * Executes the handler's business logic.
   * Implementors that perform async I/O should check `signal?.aborted` between operations
   * and throw if true, rather than completing work that has already been cancelled.
   */
  execute(
    inputs: StepHandlerInputs,
    context: StepContext,
    signal?: AbortSignal,
  ): Promise<StepHandlerResult>;
}
