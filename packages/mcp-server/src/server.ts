#!/usr/bin/env node
// realm-mcp — MCP server exposing the Realm workflow engine to AI agents.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ExtensionRegistry,
  JsonWorkflowStore,
  JsonFileStore,
  FailedAttemptStore,
  WorkflowError,
  createDefaultRegistry,
  validateTraceCapabilities,
  type RunStore,
  type TraceBufferStore,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';
import { registerListWorkflows } from './tools/list-workflows.js';
import { registerGetWorkflowProtocol } from './tools/get-workflow-protocol.js';
import { registerStartRun } from './tools/start-run.js';
import type { FailedAttemptStoreLike } from './tools/start-run.js';
import { registerExecuteStep } from './tools/execute-step.js';
import { registerSubmitHumanResponse } from './tools/submit-human-response.js';
import { registerGetRunState } from './tools/get-run-state.js';
import { registerAbandonRun } from './tools/abandon-run.js';
import { registerCreateWorkflow } from './tools/create-workflow.js';
import { registerAppendTrace } from './tools/append-trace.js';
import { registerStartRunBatch } from './tools/start-run-batch.js';

export interface RealmMcpServerOptions {
  /** Extension registry for resolving service adapters and step handlers at runtime. */
  registry?: ExtensionRegistry;
  /**
   * Per-definition registry resolution (project extensions). Awaited BEFORE `runStore.create`
   * in start_run / start_run_batch (a throwing provider means no run is created) and before
   * execution in execute_step. When both `registry` and `registryProvider` are supplied, the
   * provider wins. Additive — absent provider preserves existing behavior.
   */
  registryProvider?: (definition: WorkflowDefinition) => Promise<ExtensionRegistry>;
  /** Pre-populated workflow store. When provided, tools use this instead of creating
   *  a new JsonWorkflowStore() pointing at ~/.realm/workflows/. */
  workflowStore?: JsonWorkflowStore;
  /**
   * Run store. Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only).
   * When omitted, defaults to a new `JsonFileStore()` pointing at `~/.realm/runs/`.
   *
   * **Co-location contract with `traceBufferStore` / `failedAttemptStore` below:** the run store
   * and the trace-buffer / failed-attempt artifact stores MUST share ONE reachability domain.
   * `append_trace` writes a WAL that `execute_step` reads back at finalization, and the
   * failed-attempt sidecar is looked up the same way — if the run store and the artifact stores
   * point at DIFFERENT backing domains (e.g. a cloud run store paired with a locally-derived
   * trace buffer, or vice versa), traces and sidecar entries are silently lost: nothing will ever
   * look in the same place twice. Two supported configurations:
   *  - **Local default (unchanged, byte-identical to pre-#188 behavior):** no `traceBufferStore`/
   *    `failedAttemptStore` injected, and the run store exposes `runsDirPath` (the `JsonFileStore`
   *    case) → both artifact stores are derived from that path, exactly as before this PR.
   *  - **Injected / single-domain-blessed (the cloud case):** inject BOTH `traceBufferStore` AND
   *    `failedAttemptStore` as objects already co-located with the run store's own domain (e.g.
   *    both backed by the same Postgres database or object-storage bucket the run store uses) —
   *    the INJECTOR guarantees co-location; `createRealmMcpServer` does not and cannot verify it.
   *
   * A run store that does NOT expose `runsDirPath` (cannot derive a local path) AND has NOT had
   * BOTH artifact stores injected is a misconfiguration: `createRealmMcpServer` throws rather than
   * silently falling back to an empty or wrong-domain artifact store.
   */
  runStore?: RunStore;
  /**
   * Trace-buffer WAL store for incremental agent-trace ingestion (B-lite). Object injection, not
   * a path string — a Postgres/object-storage-backed run store has no filesystem directory to
   * derive one from. See the co-location contract on `runStore` above.
   */
  traceBufferStore?: TraceBufferStore;
  /**
   * Durable per-run failed-attempt sidecar store (observability P3). Object injection — see the
   * co-location contract on `runStore` above.
   */
  failedAttemptStore?: FailedAttemptStoreLike;
}

/**
 * Returns an ExtensionRegistry pre-populated with Realm's built-in adapters.
 * `FileSystemAdapter` is registered under the name `'filesystem'`.
 *
 * Use this as a starting point when you need to add your own handlers or adapters on top:
 * ```ts
 * const registry = createDefaultRegistry();
 * registry.register('handler', 'my_handler', myHandler);
 * const server = createRealmMcpServer({ workflowStore, registry });
 * ```
 *
 * When no registry is passed to `createRealmMcpServer`, the engine uses built-in adapters
 * automatically — you only need this if you are adding custom extensions.
 */
export { createDefaultRegistry };

/**
 * Creates and configures the Realm MCP server with all 9 workflow tools.
 *
 * When no `registry` is provided, `FileSystemAdapter` is pre-registered automatically
 * under the name `filesystem`. Pass a custom `registry` to add your own handlers and
 * adapters — when you do, include `FileSystemAdapter` explicitly if your workflows use it,
 * or start from `createDefaultRegistry()` and add your extensions on top.
 */
export function createRealmMcpServer(options?: RealmMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'realm',
    version: '0.36.0',
  });

  // When no registry is provided, use the default registry that pre-registers built-in
  // adapters. When a registry is provided, the caller is responsible for its contents.
  const effectiveRegistry = options?.registry ?? createDefaultRegistry();

  // Default the workflow store the same way (mirrors effectiveRegistry / effectiveRunStore). This is
  // what lets get_run_state compute next_actions on the option-less entrypoint path — without it,
  // get_run_state would silently degrade to 'workflow_unresolved'. Behaviour-preserving for every
  // other tool: start_run/start_run_batch/etc. already fall back to the same default
  // (`~/.realm/workflows`) internally, so receiving it explicitly changes nothing for them.
  const effectiveWorkflowStore = options?.workflowStore ?? new JsonWorkflowStore();

  const effectiveOptions: RealmMcpServerOptions = {
    ...options,
    registry: effectiveRegistry,
    workflowStore: effectiveWorkflowStore,
  };

  // Shared trace buffer store: one instance used by both append_trace and execute_step so
  // WAL entries written by append_trace are visible when execute_step finalizes the step.
  const effectiveRunStore: RunStore = options?.runStore ?? new JsonFileStore();

  // issue #188, PR-1: the co-location seam. See the doc comment on `runStore` above for the full
  // contract. Three cases, checked in order:
  let traceBufferStore: TraceBufferStore;
  let failedAttemptStore: FailedAttemptStoreLike;
  if (options?.traceBufferStore !== undefined && options?.failedAttemptStore !== undefined) {
    // Both injected — the injector guarantees co-location (see the contract doc above); use them
    // as-is, no derivation.
    traceBufferStore = options.traceBufferStore;
    failedAttemptStore = options.failedAttemptStore;
  } else if ('runsDirPath' in effectiveRunStore) {
    // The local JsonFileStore case — derive whichever artifact store was NOT already injected
    // from the run store's own directory. When neither was injected (the ordinary local-default
    // path), this is byte-identical to pre-#188 behavior. A store the caller DID inject here
    // (a partial injection) is still respected, never silently overridden.
    const runsDirPath = (effectiveRunStore as JsonFileStore).runsDirPath;
    traceBufferStore = options?.traceBufferStore ?? new JsonTraceBufferStore(runsDirPath);
    failedAttemptStore = options?.failedAttemptStore ?? new FailedAttemptStore(runsDirPath);
  } else {
    // The run store cannot supply an artifact directory (e.g. a Postgres-backed RunStore) AND no
    // artifact stores were injected — a misconfiguration. Fail loud rather than silently deriving
    // an empty or wrong-domain store that would lose every trace/sidecar entry at finalization.
    throw new WorkflowError(
      "createRealmMcpServer: the run store does not expose 'runsDirPath' (it is not a local " +
        'JsonFileStore) and no traceBufferStore/failedAttemptStore were injected. Artifact ' +
        'stores cannot be derived — inject BOTH traceBufferStore and failedAttemptStore ' +
        "co-located with the run store's own domain, or use a JsonFileStore run store.",
      {
        code: 'ENGINE_INTERNAL',
        category: 'ENGINE',
        agentAction: 'stop',
        retryable: false,
      },
    );
  }

  // issue #197 PR-2 (deliverable 2g): validate the store's capability declaration is internally
  // consistent AT CONSTRUCTION — covers BOTH the derived-local default and the injected path
  // above (this runs after `traceBufferStore` is finalized regardless of which branch produced
  // it). A declared-but-inconsistent rung (e.g. `seal` claimed without the fenced trio +
  // sealFenced + listSealedForRun all actually present) is a construction-time wiring defect —
  // typed fail-loud here, never a runtime condition discovered later. Undeclared (the honest
  // floor — trio-alone, or no capabilities at all) is always silent success, never an error.
  validateTraceCapabilities(traceBufferStore);

  registerListWorkflows(server, effectiveOptions);
  registerGetWorkflowProtocol(server, effectiveOptions);
  registerStartRun(server, effectiveOptions);
  registerStartRunBatch(server, effectiveOptions);
  registerExecuteStep(server, { ...effectiveOptions, traceBufferStore, failedAttemptStore });
  registerSubmitHumanResponse(server, effectiveOptions);
  registerGetRunState(server, effectiveOptions);
  registerAbandonRun(server, effectiveOptions);
  registerCreateWorkflow(server, effectiveOptions);
  registerAppendTrace(server, {
    runStore: effectiveRunStore,
    ...(options?.workflowStore !== undefined ? { workflowStore: options.workflowStore } : {}),
    traceBufferStore,
  });

  return server;
}

// Entry point: start the MCP server on stdio when run directly.
// argv[1] is realpath-resolved because npm/npx bin shims invoke this file through
// a symlink (node_modules/.bin/realm-mcp), while import.meta.url holds the resolved
// target path — a plain string comparison never matches and the process would exit
// silently without connecting the transport.
function isRunDirectly(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  const server = createRealmMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
