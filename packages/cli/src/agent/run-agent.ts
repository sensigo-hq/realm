// run-agent.ts — Core agent loop logic, decoupled from the Commander handler for testability.
// Exports runAgent(), AgentDeps, AgentRunOptions, and AgentRunResult.
// All Slack-specific gate notification logic lives in slack-gate-notifier.ts.
import { join } from 'node:path';
import {
  loadWorkflowFromFile,
  findEligibleSteps,
  classifyInProgressClaims,
  executeChain,
  buildNextActions,
  WorkflowError,
  type RunStore,
  type WorkflowDefinition,
  type StepDefinition,
  type PendingGate,
  type ExtensionRegistry,
  type McpServerConfig,
  type ToolCallRecord,
} from '@sensigo/realm';
import type { WorkflowRegistrar } from '@sensigo/realm';
import type { LlmProvider } from './providers/llm-provider.js';
import { setAdditionalRedactionValues } from './providers/agent-utils.js';
import { isToolCapable } from './providers/llm-provider.js';
import type { McpClient, ToolDefinition, ToolExecutor } from './mcp/mcp-extensions.js';
import { McpClient as McpClientImpl } from './mcp/mcp-client.js';

export type AgentRunResult = 'completed' | 'failed';

export interface AgentDeps {
  store: RunStore;
  workflowStore: WorkflowRegistrar;
  provider: LlmProvider;
  registry: ExtensionRegistry;
  /**
   * When set, called for every pending gate. The handler is responsible for notifying
   * the relevant channel and blocking until the gate resolves.
   * Omit for terminal-only fallback (choices printed to terminal + store polling).
   */
  gateHandler?: (runId: string, gate: PendingGate) => Promise<void>;
  /**
   * Factory for creating an McpClient instance. Injected by tests for mock isolation.
   * Defaults to constructing a real McpClient when absent.
   */
  mcpClientFactory?: (servers: McpServerConfig[], signal?: AbortSignal) => McpClient;
  /**
   * REAL manifest-secret VALUES (values only, from the loaded extensions result) fed to
   * the provider-loop redaction pass — dotenv-sourced values are absent from process.env
   * and would otherwise pass tool results/traces unredacted. Never persisted.
   */
  redactionValues?: readonly string[];
}

export interface AgentRunOptions {
  /** Path to workflow.yaml file. Required when definition is not provided. */
  workflowPath?: string;
  /** Inline workflow definition — bypasses loadWorkflowFromFile when provided. */
  definition?: WorkflowDefinition;
  /**
   * Attach to an existing run instead of creating a new one.
   * When set, runAgent() skips deps.store.create() and uses this ID directly.
   * Mutually exclusive with workflowPath — runAgent() throws if both are set.
   */
  existingRunId?: string;
  params: Record<string, unknown>;
  /** Poll interval in ms for the terminal-only fallback. Defaults to 3000. Lower values are useful in tests. */
  pollIntervalMs?: number;
  /**
   * When true, persist the workflow definition to ~/.realm/workflows/ so that
   * `realm run inspect` and `realm run list` can resolve it by ID.
   * Defaults to false — realm agent does not register workflows as a side effect.
   */
  register?: boolean;
}

/**
 * Renders a display template against a flat vars object.
 * Syntax: {{ field }} or {{ nested.field }} — plain dot-path interpolation, no filters.
 * Missing paths render as empty string.
 */
function renderDisplay(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    let val: unknown = vars;
    for (const part of parts) {
      if (typeof val !== 'object' || val === null) {
        val = undefined;
        break;
      }
      val = (val as Record<string, unknown>)[part];
    }
    return val === undefined ? '' : typeof val === 'string' ? val : JSON.stringify(val);
  });
}

/**
 * Formats a step output object as human-readable plain text for the terminal.
 * Renders `headline` and `message` string fields directly; falls back to JSON.
 */
function formatOutputForTerminal(output: Record<string, unknown>): string {
  const headline = typeof output['headline'] === 'string' ? output['headline'] : undefined;
  const message = typeof output['message'] === 'string' ? output['message'] : undefined;

  if (headline !== undefined || message !== undefined) {
    const parts: string[] = [];
    if (headline !== undefined) parts.push(headline);
    if (message !== undefined) parts.push(message);
    return parts.join('\n\n');
  }

  if (Object.keys(output).length === 0) {
    return '(no output)';
  }

  return JSON.stringify(output, null, 2);
}

async function pollUntilGateResolved(
  store: RunStore,
  runId: string,
  gateId: string,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  console.log('   Waiting for approval...');
  for (;;) {
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
    if (signal?.aborted) break;
    const run = await store.get(runId);
    if (run.terminal_state) break;
    if (run.pending_gate === undefined || run.pending_gate.gate_id !== gateId) break;
  }
}

/**
 * Runs a workflow to completion using the provided dependencies.
 * Returns 'completed' when the run finishes normally; 'failed' otherwise.
 * Throws on setup failures (e.g. workflow file not found, provider error).
 */
export async function runAgent(deps: AgentDeps, options: AgentRunOptions): Promise<AgentRunResult> {
  if (options.existingRunId !== undefined && options.workflowPath !== undefined) {
    throw new Error('existingRunId and workflowPath are mutually exclusive');
  }

  // Manifest-secret redaction (values only, set ONCE per run): tool results and
  // tool-execution errors serialized by the provider loop get these values masked
  // alongside process.env values.
  setAdditionalRedactionValues(deps.redactionValues ?? []);

  // Load or use provided definition.
  const definition: WorkflowDefinition =
    options.definition !== undefined
      ? options.definition
      : loadWorkflowFromFile(
          options.workflowPath!.endsWith('.yaml') || options.workflowPath!.endsWith('.yml')
            ? options.workflowPath!
            : join(options.workflowPath!, 'workflow.yaml'),
        );

  // Register only when explicitly requested (--register flag).
  // By default realm agent does not write to ~/.realm/workflows/ as a side effect.
  if (options.register === true) {
    await deps.workflowStore.register(definition);
  }

  let runId: string;
  let currentRun;

  if (options.existingRunId !== undefined) {
    // --run-id path: attach to existing run
    currentRun = await deps.store.get(options.existingRunId);
    if (currentRun.terminal_state) {
      throw new Error(
        `Run ${options.existingRunId} is already in terminal state: ${currentRun.terminal_reason ?? currentRun.run_phase}`,
      );
    }
    runId = options.existingRunId;
    // in_progress_steps on attach: handled by engine's existing eligibility logic — no restart needed
  } else {
    // Normal path: create new run
    const { run: initialRecord } = await deps.store.create({
      workflowId: definition.id,
      workflowVersion: definition.version,
      params: options.params,
    });
    runId = initialRecord.id;
    currentRun = await deps.store.get(runId);
  }

  console.log(`\nRealm Agent — ${definition.name} v${definition.version}`);
  console.log(`Run ID: ${runId}\n`);

  // Initialise MCP client if any steps declare tools.
  let mcpClient: McpClient | undefined;
  if (definition.mcp_servers !== undefined && definition.mcp_servers.length > 0) {
    const serverIds = new Set(definition.mcp_servers.map((s) => s.id));
    for (const step of Object.values(definition.steps)) {
      for (const toolEntry of step.tools ?? []) {
        const serverId = toolEntry.split(':')[0] ?? '';
        if (!serverIds.has(serverId)) {
          throw new Error(`Step tool '${toolEntry}' references unknown MCP server '${serverId}'`);
        }
      }
    }
    mcpClient = (deps.mcpClientFactory ?? ((s, sig) => new McpClientImpl(s, sig)))(
      definition.mcp_servers,
      undefined, // AbortSignal not threaded into runAgent — disconnect() is in finally
    );
    if (!isToolCapable(deps.provider)) {
      throw new Error(
        'This workflow uses MCP tool-enabled steps, but the configured LLM provider does not support tool calling. ' +
          'Reasoning models (o1-series) and custom non-tool providers cannot run tool-enabled steps. ' +
          'Use --provider openai with a standard chat model (e.g. gpt-4o), or --provider anthropic.',
      );
    }
  }

  try {
    while (!currentRun.terminal_state) {
      // --- Gate handling ---
      if (currentRun.pending_gate !== undefined) {
        const gate = currentRun.pending_gate;

        console.log(`\n⏸  Gate: ${gate.step_name} | ID: ${gate.gate_id}`);
        const gateStepDef = definition.steps[gate.step_name];
        const gateText =
          gate.resolved_message ??
          (gateStepDef?.display !== undefined
            ? renderDisplay(gateStepDef.display, gate.preview)
            : formatOutputForTerminal(gate.preview));
        const indented = gateText
          .trimEnd()
          .split('\n')
          .map((l) => `   ${l}`)
          .join('\n');
        console.log('\n' + indented + '\n');

        if (deps.gateHandler !== undefined) {
          await deps.gateHandler(runId, gate);
        } else {
          // Terminal fallback: print each choice as a command and poll.
          for (const choice of gate.choices) {
            const label = choice.charAt(0).toUpperCase() + choice.slice(1);
            console.log(
              `   ${label}: realm run respond ${runId} --gate ${gate.gate_id} --choice ${choice}`,
            );
          }
          await pollUntilGateResolved(
            deps.store,
            runId,
            gate.gate_id,
            options.pollIntervalMs ?? 3000,
          );
        }

        currentRun = await deps.store.get(runId);
        continue;
      }

      // --- Step execution ---
      const eligible = findEligibleSteps(definition, currentRun);
      if (eligible.length === 0) {
        // Detect-only wedge surfacing (issue #101): before exiting on "nothing eligible", check
        // whether the run is an after-claim wedge (an in-progress claim that is stale or
        // unknown-age). If so, print the claim state(s) + the exact reclaim remediation so the
        // operator is never silently parked. Phase 1 attach does NOT auto-reclaim.
        if (currentRun.in_progress_steps.length > 0) {
          const wedged = classifyInProgressClaims(currentRun).filter((c) => c.state !== 'healthy');
          if (wedged.length > 0) {
            console.log(
              `\n   ⚠ Run '${runId}' is wedged — a claimed step never settled (its runner likely died):`,
            );
            for (const c of wedged) {
              console.log(`     • ${c.step}: ${c.state}`);
              console.log(
                `       recover with: realm run reclaim ${runId} --step ${c.step} --force`,
              );
            }
            console.log(
              `   (reclaim re-drives the step; its side effects may repeat — see 'realm run reclaim ${runId}' for a dry-run.)`,
            );
          }
        }
        break;
      }

      const stepName = eligible[0]!;
      const stepDef: StepDefinition = definition.steps[stepName]!;

      let stepInput: Record<string, unknown>;
      let toolCallsForMeta: ToolCallRecord[] | undefined;

      if (stepDef.execution === 'agent') {
        // Resolve template-expanded prompt via buildNextActions so {{ context.resources.* }}
        // references are substituted before the LLM call.
        const nextActions = buildNextActions(definition, currentRun);
        const nextAction =
          nextActions.find(
            (a) =>
              a.instruction !== null &&
              (a.instruction.call_with['command'] as string | undefined) === stepName,
          ) ?? nextActions[0];

        const prompt = nextAction?.prompt ?? stepDef.description;
        const inputSchema =
          (nextAction?.input_schema as Record<string, unknown> | undefined) ??
          (stepDef.input_schema as Record<string, unknown> | undefined);
        const agentProfileInstructions =
          stepDef.agent_profile !== undefined
            ? definition.resolved_profiles?.[stepDef.agent_profile]?.content
            : undefined;

        const descPreview = stepDef.description.slice(0, 80);
        console.log(`\n→ [agent] ${stepName}`);
        console.log(`  ${descPreview}${stepDef.description.length > 80 ? '…' : ''}`);

        if (stepDef.tools && stepDef.tools.length > 0 && mcpClient) {
          // Tools path: build tool definitions, call callStepWithTools.
          const byServer = new Map<string, string[]>();
          for (const entry of stepDef.tools) {
            const [serverId, toolName] = entry.split(':') as [string, string];
            if (!byServer.has(serverId)) byServer.set(serverId, []);
            byServer.get(serverId)!.push(toolName);
          }

          let toolsResult;
          try {
            const toolDefs: ToolDefinition[] = [];
            const barenameOwner = new Map<string, string>(); // bareName → serverId of first registration
            for (const [serverId, allowList] of byServer) {
              const mcpTools = await mcpClient.getTools(serverId, allowList);

              const returnedNames = new Set(mcpTools.map((t) => t.name));
              for (const name of allowList) {
                if (!returnedNames.has(name)) {
                  throw new WorkflowError(
                    `Step '${stepName}' declares tool '${serverId}:${name}' which is not exposed by MCP server '${serverId}'. ` +
                      `Check the tool name against the server's published tool list.`,
                    {
                      code: 'MCP_TOOL_NOT_FOUND',
                      category: 'ENGINE',
                      agentAction: 'stop',
                      retryable: false,
                    },
                  );
                }
              }

              for (const mcpTool of mcpTools) {
                const firstOwner = barenameOwner.get(mcpTool.name);
                if (firstOwner !== undefined) {
                  throw new WorkflowError(
                    `Tool name collision in step '${stepName}': '${mcpTool.name}' is exposed by both '${firstOwner}' and '${serverId}'. ` +
                      `Tool names must be unique across all connected servers within a step.`,
                    {
                      code: 'MCP_TOOL_NAME_COLLISION',
                      category: 'ENGINE',
                      agentAction: 'stop',
                      retryable: false,
                    },
                  );
                }
                barenameOwner.set(mcpTool.name, serverId);
                toolDefs.push({
                  id: `${serverId}:${mcpTool.name}`,
                  serverId,
                  name: mcpTool.name,
                  description: mcpTool.description,
                  inputSchema: mcpTool.inputSchema,
                });
              }
            }

            const baseExecutor: ToolExecutor = async (namespacedName, args) => {
              const [serverId, toolName] = namespacedName.split(':') as [string, string];
              return mcpClient!.call(serverId, toolName, args);
            };

            // Wrap the executor to enforce max_fan_out when set.
            // Counts calls to start_run and start_run_batch (regardless of server prefix).
            let fanOutCallCount = 0;
            const maxFanOut = stepDef.max_fan_out;
            const executor: ToolExecutor = async (namespacedName, args) => {
              const toolName = namespacedName.includes(':')
                ? namespacedName.split(':')[1]!
                : namespacedName;
              if (toolName === 'start_run' || toolName === 'start_run_batch') {
                fanOutCallCount += 1;
                if (maxFanOut !== undefined && fanOutCallCount > maxFanOut) {
                  throw new WorkflowError(
                    `max_fan_out of ${maxFanOut} reached for step '${stepName}'. ` +
                      `No further start_run or start_run_batch calls are permitted in this step.`,
                    {
                      code: 'VALIDATION_BATCH_TOO_LARGE',
                      category: 'VALIDATION',
                      agentAction: 'provide_input',
                      retryable: false,
                    },
                  );
                }
              }
              return baseExecutor(namespacedName, args);
            };

            if (!isToolCapable(deps.provider)) {
              throw new Error(
                'invariant: provider lost tool capability between startup and step execution',
              );
            }
            toolsResult = await deps.provider.callStepWithTools(prompt, toolDefs, executor, {
              ...(stepDef.input_schema !== undefined
                ? { inputSchema: stepDef.input_schema as Record<string, unknown> }
                : {}),
              maxToolCalls: stepDef.max_tool_calls ?? 20,
              ...(stepDef.max_fan_out !== undefined ? { maxFanOut: stepDef.max_fan_out } : {}),
              toolTimeoutMs: (stepDef.tool_timeout ?? 30) * 1000,
              ...(agentProfileInstructions !== undefined ? { agentProfileInstructions } : {}),
            });
          } catch (err) {
            console.error(
              `\n✗ Step '${stepName}' (tools) failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return 'failed';
          }
          stepInput = toolsResult.output;
          toolCallsForMeta = toolsResult.toolCalls;
        } else {
          // Retry the LLM call once on failure before giving up.
          let callError: unknown;
          stepInput = {};
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              stepInput = await deps.provider.callStep(
                prompt,
                inputSchema,
                agentProfileInstructions,
              );
              callError = undefined;
              break;
            } catch (err) {
              callError = err;
              console.warn(
                `  ⚠  LLM call attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (callError !== undefined) {
            console.error(`\n✗ Step '${stepName}' LLM call failed after 2 attempts`);
            return 'failed';
          }
        }
      } else {
        // Auto step — the engine dispatches to the service adapter directly.
        console.log(`→ [auto] ${stepName}`);
        stepInput = {};
      }

      const result = await executeChain(deps.store, definition, {
        runId,
        command: stepName,
        input: stepInput,
        dispatcher: async () => stepInput,
        registry: deps.registry,
        ...(toolCallsForMeta !== undefined ? { stepMeta: { toolCalls: toolCallsForMeta } } : {}),
      });

      if (result.status === 'error') {
        console.error(`\n✗ Step '${stepName}' failed: ${result.errors.join(', ')}`);
        return 'failed';
      }

      if (result.status === 'confirm_required') {
        // Gate will be handled at the top of the next iteration.
        currentRun = await deps.store.get(runId);
        continue;
      }

      currentRun = await deps.store.get(runId);
      console.log(`  ✓ → ${currentRun.run_phase}`);
    }
  } finally {
    if (mcpClient) {
      await mcpClient.disconnect();
    }
  }

  if (currentRun.run_phase === 'completed') {
    console.log(`\nRun complete: ${runId}`);

    // Print the last agent step's output so the result is visible without
    // a separate `realm run inspect` call.
    const lastAgentEvidence = [...currentRun.evidence]
      .reverse()
      .find(
        (snapshot) =>
          snapshot.status === 'success' &&
          snapshot.kind !== 'gate_response' &&
          definition.steps[snapshot.step_id]?.execution === 'agent',
      );
    if (lastAgentEvidence !== undefined) {
      console.log(`\nResult (${lastAgentEvidence.step_id}):`);
      const stepDef = definition.steps[lastAgentEvidence.step_id];
      const formatted =
        stepDef?.display !== undefined
          ? renderDisplay(stepDef.display, lastAgentEvidence.output_summary)
          : formatOutputForTerminal(lastAgentEvidence.output_summary);
      console.log(formatted);
    }

    return 'completed';
  }

  console.error(`\nRun ended in phase: ${currentRun.run_phase}`);
  return 'failed';
}
