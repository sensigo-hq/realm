// Protocol generator — produces the full agent briefing from a WorkflowDefinition.
// This is what an AI agent reads before starting a workflow run.
import type { WorkflowDefinition, JsonSchema } from '@sensigo/realm';

export interface ProtocolStepGate {
  choices: string[];
}

export interface ProtocolStep {
  id: string;
  description: string;
  execution: string;
  /** Plain-English description of the agent's role at this step. */
  agent_involvement: string;
  input_schema?: JsonSchema;
  /** Step-level instructions for the agent, if defined. */
  instructions?: string;
  /** Present when the step may open a human gate. */
  possible_gate?: ProtocolStepGate;
  /** Step IDs this step depends on before it becomes eligible. */
  depends_on?: string[];
  /** Specialist profile instructions for the agent at this step. Present when the step
   *  declares agent_profile and the profile was resolved at register time. */
  agent_profile_instructions?: string;
}

export interface WorkflowProtocol {
  workflow_id: string;
  name: string;
  /** Declarative statement of what this workflow is for / when to use it. Present only when
   *  the workflow declares one — no synthesized default (distinct from quick_start below). */
  description?: string;
  params_schema?: JsonSchema;
  steps: ProtocolStep[];
  /** e.g. "2 of 4 steps require agent action. 2 are handled automatically." */
  agent_steps_summary: string;
  rules: string[];
  error_handling: Record<string, string>;
  quick_start: string;
}

const DEFAULT_RULES = [
  'Follow the next_action instruction in each response exactly.',
  "When you receive status 'confirm_required', read gate.agent_hint for instructions, present gate.display to the user verbatim, wait for their response, then call submit_human_response with their choice and the gate_id.",
  'Do NOT auto-confirm any human gate. The user must decide.',
  'Do NOT ask the user for permission between steps unless the system tells you to.',
];

const ERROR_HANDLING: Record<string, string> = {
  provide_input:
    'The engine rejected your input. Read the error details — they tell you exactly what was wrong. Fix the input and call the step again.',
  report_to_user:
    'Something failed that you cannot fix automatically. Show the error message to the user and wait for their guidance.',
  resolve_precondition:
    'A prerequisite step has not completed. The error includes which precondition failed and what step to call. Follow the suggestion.',
  stop: 'A critical error occurred. Report it to the user and do not attempt any further steps.',
  wait_for_human:
    'An external service is unavailable and cannot be retried automatically (e.g. network unreachable, upstream server error). Show the error to the user and wait for them to confirm the issue is resolved — the run cannot continue until the external dependency is back.',
  wait_and_proceed:
    'The upstream service returned a rate-limit response. retry_after in the envelope gives the number of seconds to wait. After that delay, follow next_actions without human involvement — the step has already failed; if a recovery branch exists it will appear in next_actions. This action only appears when engine-level retry is not configured for the step; when retry is configured, the engine retries internally and surfaces STEP_RETRY_EXHAUSTED (report_to_user) on exhaustion of attempts or total-time budget.',
};

/**
 * Generates the full agent protocol briefing from a WorkflowDefinition.
 */
export function generateProtocol(definition: WorkflowDefinition): WorkflowProtocol {
  const steps: ProtocolStep[] = [];
  let agentStepCount = 0;
  let autoStepCount = 0;

  for (const [id, step] of Object.entries(definition.steps)) {
    const hasGate = step.trust === 'human_confirmed' || step.trust === 'human_reviewed';

    let agent_involvement: string;
    let possible_gate: ProtocolStepGate | undefined;

    if (step.execution === 'guard' || step.execution === 'finalizer') {
      // Engine-run steps — never agent-executed. Previously these fell through to the final
      // branch and were wrongly briefed as "YOU execute this step" (guard was already
      // mis-briefed; finalizer would be too). The agent must never call execute_step for them.
      agent_involvement = `none — the engine runs this ${step.execution} step automatically; do NOT call execute_step for it.`;
    } else if (step.execution === 'auto' && !hasGate) {
      agent_involvement = 'none — engine handles this automatically';
      autoStepCount++;
    } else if (step.execution === 'auto' && hasGate) {
      agent_involvement =
        'YOU will receive `status: confirm_required` after this step runs — the engine executes it automatically, then opens a gate. Read `gate.agent_hint` for presentation instructions, present `gate.display` to the user verbatim, collect their choice from `gate.response_spec.choices`, and call `submit_human_response`.';
      possible_gate = { choices: ['approve', 'reject'] };
      autoStepCount++;
    } else if (step.execution === 'agent' && !hasGate) {
      agent_involvement = `YOU execute this step. Call execute_step with command '${id}' and the required params.`;

      // If an immediate downstream auto+gate step depends only on this step, warn the
      // agent that they will receive confirm_required rather than ok after submitting.
      const immediateGateStep = Object.entries(definition.steps).find(
        ([, s]) =>
          s.execution === 'auto' &&
          (s.trust === 'human_confirmed' || s.trust === 'human_reviewed') &&
          Array.isArray(s.depends_on) &&
          s.depends_on.length === 1 &&
          s.depends_on[0] === id,
      );
      if (immediateGateStep !== undefined) {
        agent_involvement += ` After you submit, you will receive status: confirm_required directly in response to this call — the engine runs '${immediateGateStep[0]}' automatically before returning.`;
      }

      agentStepCount++;
    } else {
      // execution === 'agent' with gate
      agent_involvement = `YOU execute this step. Call execute_step with command '${id}'. The engine will run your dispatcher, then pause for human confirmation of your output.`;
      possible_gate = { choices: ['approve', 'reject'] };
      agentStepCount++;
    }

    const protocolStep: ProtocolStep = {
      id,
      description: step.description,
      execution: step.execution,
      agent_involvement,
    };

    if (step.input_schema !== undefined) {
      protocolStep.input_schema = step.input_schema;
    }
    if (step.instructions !== undefined) {
      protocolStep.instructions = step.instructions;
    }
    if (possible_gate !== undefined) {
      protocolStep.possible_gate = possible_gate;
    }
    if (step.depends_on !== undefined && step.depends_on.length > 0) {
      protocolStep.depends_on = step.depends_on;
    }
    const profile = step.agent_profile;
    if (profile !== undefined && definition.resolved_profiles?.[profile] !== undefined) {
      protocolStep.agent_profile_instructions = definition.resolved_profiles[profile].content;
    }

    steps.push(protocolStep);
  }

  const totalSteps = steps.length;
  // issue #425: each clause agrees with its OWN count — the noun with the total it counts, and
  // each verb with the subject in front of it. Keying the verb on totalSteps is the plausible
  // wrong fix and produces "1 of 3 steps require" for three steps of which one is an agent step.
  const agent_steps_summary =
    `${agentStepCount} of ${totalSteps} ${totalSteps === 1 ? 'step' : 'steps'} ` +
    `${agentStepCount === 1 ? 'requires' : 'require'} agent action. ` +
    `${autoStepCount} ${autoStepCount === 1 ? 'is' : 'are'} handled automatically.`;

  const rules = definition.protocol?.rules ?? DEFAULT_RULES;

  // issue #178: `??` only falls back on null/undefined — an empty or whitespace-only authored
  // quick_start is a "present" value that would otherwise win and blank out the generated
  // default. Treat it as absent instead; a genuinely non-empty value (including one with
  // incidental surrounding whitespace around real content) is still used verbatim.
  const authoredQuickStart = definition.protocol?.quick_start;
  const quick_start =
    authoredQuickStart !== undefined && authoredQuickStart.trim() !== ''
      ? authoredQuickStart
      : `Call start_run with workflow_id '${definition.id}'. ${agentStepCount > 0 ? `The engine will run auto steps automatically and return control at the first step requiring agent action.` : `The engine handles all steps automatically.`} Follow the next_action in each response until the workflow completes.`;

  const protocol: WorkflowProtocol = {
    workflow_id: definition.id,
    name: definition.name,
    steps,
    agent_steps_summary,
    rules,
    error_handling: ERROR_HANDLING,
    quick_start,
  };

  if (definition.params_schema !== undefined) {
    protocol.params_schema = definition.params_schema;
  }

  if (definition.description !== undefined) {
    protocol.description = definition.description;
  }

  return protocol;
}
