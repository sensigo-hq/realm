// Protocol generator — produces the full agent briefing from a WorkflowDefinition.
// This is what an AI agent reads before starting a workflow run.
import type { WorkflowDefinition, JsonSchema } from '@sensigo/realm';
import { classifyStepTrust, buildTrustRefusal, renderTrustValue } from '@sensigo/realm';

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
  // issue #508: steps L2 will refuse at dispatch — an invalid `trust` value. Tracked
  // separately from agent/auto so neither count silently absorbs a step that will never
  // actually run the way its execution kind implies.
  let refusedStepCount = 0;

  for (const [id, step] of Object.entries(definition.steps)) {
    const trustVerdict = classifyStepTrust(step.execution, step.trust);
    const hasGate = trustVerdict === 'gates';

    let agent_involvement: string;
    let possible_gate: ProtocolStepGate | undefined;

    if (step.execution === 'guard' || step.execution === 'finalizer') {
      // Engine-run steps — never agent-executed. Previously these fell through to the final
      // branch and were wrongly briefed as "YOU execute this step" (guard was already
      // mis-briefed; finalizer would be too). The agent must never call execute_step for them.
      // issue #508: a `trust` value declared here is inert-or-invalid by construction
      // (guard/finalizer never gate) — say so, rather than staying silent about a declaration
      // the engine ignores. A refuse here is NOT dispatch-fatal (unlike auto/agent) since the
      // engine never reads `trust` on this execution kind at all, so refusedStepCount is not
      // incremented.
      //
      // issue #508 correction (item 6): two defects fixed. (1) `String()` made `null` and the
      // string `"null"` indistinguishable, one line above a sibling branch that already uses
      // `JSON.stringify` — switched to match. (2) the note rendered IDENTICALLY for a LAWFUL,
      // accepted-but-inert value (`finalizer + 'auto'`) and an UNLAWFUL one the loader would
      // refuse outright (`finalizer + 'human_confirmed'`, or ANY declared value on a guard) —
      // now forks on `trustVerdict`, which is only ever 'lawful_no_gate' or 'refuse' inside this
      // branch (absence is excluded by the outer `step.trust !== undefined` check).
      //
      // issue #508 (final correction): this is NOT a refusal — a disclosure of an inert-or-
      // invalid declaration the engine never reads on this kind — so it keeps its own text
      // rather than routing through `buildTrustRefusal`. It DOES now consume that composer's
      // exported `renderTrustValue`, the one rendering rule every trust-value message shares
      // (`JSON.stringify`, unconditionally), so this site's rendering cannot drift back apart
      // from the refusal surfaces' even though its own prose stays bespoke.
      const trustNote =
        step.trust === undefined
          ? ''
          : trustVerdict === 'lawful_no_gate'
            ? ` (this step declares 'trust: ${renderTrustValue(step.trust)}' — accepted but inert; ${step.execution} steps never gate)`
            : ` (this step declares 'trust: ${renderTrustValue(step.trust)}', which the loader refuses on ${step.execution} steps — this definition reached the protocol without going through it)`;
      agent_involvement = `none — the engine runs this ${step.execution} step automatically; do NOT call execute_step for it${trustNote}.`;
    } else if (trustVerdict === 'refuse') {
      // issue #508 (final correction): `buildTrustRefusal` (types/workflow-definition.ts) —
      // the same composer L1/L2/the run-health finding all use, with its own `'briefing'`
      // surface (added beyond the three originally sketched): `'dispatch'`'s "this run is now
      // parked" wording is FALSE here — the agent has not called `execute_step` yet, so nothing
      // has parked; only a CONDITIONAL "calling execute_step here will be refused" framing is
      // true at protocol-generation time. Without this composer, this surface used to fall back
      // to the flat generic arm regardless of value — the SAME defect the other three surfaces
      // had before this correction.
      agent_involvement = buildTrustRefusal({
        kind: step.execution,
        value: step.trust,
        step: id,
        surface: 'briefing',
      });
      refusedStepCount++;
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
          classifyStepTrust(s.execution, s.trust) === 'gates' &&
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
  // issue #508: a two-branch fork (agent-present / all-auto-clean) has no honest thing to say
  // when a refused step is ALSO present — "the engine handles all steps automatically" is false
  // for a workflow that will refuse one of them before it ever runs, and "return control at the
  // first step requiring agent action" says nothing about a step that never reaches dispatch at
  // all. The refused-present branch is checked FIRST and independently of agent/auto
  // composition — a workflow can carry a refused step alongside either of the other two shapes.
  const quick_start =
    authoredQuickStart !== undefined && authoredQuickStart.trim() !== ''
      ? authoredQuickStart
      : refusedStepCount > 0
        ? // issue #508 correction (item 6): both trailing clauses here were copied from the
          // sibling branches below, where they are true, and are false in THIS one. "Steps with
          // a valid definition proceed as normal" is false for any step that DEPENDS on the
          // refused one — it never becomes eligible, so it returns status: blocked forever, not
          // "normal". "Follow the next_action... until the workflow completes" is false twice
          // over: the refusal envelope itself carries next_actions: [] by this PR's own design
          // (execution-loop.ts omits `definition` specifically to keep that empty), and the run
          // can never reach 'completed' while the refused step is never corrected.
          `Call start_run with workflow_id '${definition.id}'. ${refusedStepCount} of this workflow's ${totalSteps} ${totalSteps === 1 ? 'step' : 'steps'} ${refusedStepCount === 1 ? 'has' : 'have'} an invalid 'trust' value and will be refused by the engine (VALIDATION_TRUST_VALUE) before it can run — see that step's agent_involvement for what to tell the user. Any step depending on it returns status: blocked until the workflow is corrected and re-registered (the refusal itself carries no next_action); steps that do not depend on it are unaffected.`
        : agentStepCount > 0
          ? `Call start_run with workflow_id '${definition.id}'. The engine will run auto steps automatically and return control at the first step requiring agent action. Follow the next_action in each response until the workflow completes.`
          : `Call start_run with workflow_id '${definition.id}'. The engine handles all steps automatically. Follow the next_action in each response until the workflow completes.`;

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
