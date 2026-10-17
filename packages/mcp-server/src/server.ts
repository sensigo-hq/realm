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
  formWaitInert,
  principalOf,
  validateTraceCapabilities,
  type Attributed,
  assertReleaseLine,
  assertRegistryLine,
  type Principal,
  type RunStore,
  type TraceBufferStore,
} from '@sensigo/realm';
import type { PriceSource, WorkflowDefinition } from '@sensigo/realm';
import { loadPriceSource, withSourceNote } from './price-source.js';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';
import { VERSION } from './version.js';
import { composeBinIdentity } from './bin-identity.js';
import { registerListWorkflows } from './tools/list-workflows.js';
import { registerGetWorkflowProtocol } from './tools/get-workflow-protocol.js';
import { registerStartRun } from './tools/start-run.js';
import type { FailedAttemptStoreLike } from './tools/start-run.js';
import { registerAdvanceRun } from './tools/advance-run.js';
import { registerExecuteStep } from './tools/execute-step.js';
import { registerSubmitHumanResponse } from './tools/submit-human-response.js';
import { registerGetRunState } from './tools/get-run-state.js';
import { registerAbandonRun } from './tools/abandon-run.js';
import { registerCreateWorkflow } from './tools/create-workflow.js';
import { registerAppendTrace } from './tools/append-trace.js';
import { registerStartRunBatch } from './tools/start-run-batch.js';
import { registerPresentQuestion } from './tools/present-question.js';
import { ABANDON_RUN_DESCRIPTION_NO_ANSWER_TOOL } from './tools/abandon-run.js';
import type { OperatorRoute } from './render-reply.js';
import {
  FORM_WAIT_ENV,
  GATE_ANSWERS_ENV,
  McpDoor,
  formWaitInertLibraryRefusal,
  formWaitLibraryRefusal,
  gateAnswersLibraryRefusal,
  judgeFormWait,
  judgeGateAnswers,
} from './door.js';
import { gateAnswersStartLine, readBinDoorSettings } from './bin-settings.js';
import type { ElicitFn } from './form-path.js';

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
  /**
   * Issue #600 caching PR P: per-definition prices for `get_run_state`'s money (`loadPriceSource`
   * with the economics file the run's deployment root names). Absent ⇒ the installed price list
   * only, and every figure says no economics file is configured on this server.
   */
  priceSourceProvider?: (definition: WorkflowDefinition) => Promise<PriceSource>;
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
   * derive one from. See the co-location contract on `runStore` above. Its run reader must read the
   * same runs as `runStore`: the fenced writes are checked against the trace buffer's own reader
   * (issue #616), never against `runStore`.
   */
  traceBufferStore?: TraceBufferStore;
  /**
   * Durable per-run failed-attempt sidecar store (observability P3). Object injection — see the
   * co-location contract on `runStore` above.
   */
  failedAttemptStore?: FailedAttemptStoreLike;
  /**
   * Issue #625 (holder slice): the host PROGRAM this server runs as — its name, how that name is
   * known, and its channel (a short word the host chooses). Written as `holder` on the claim of
   * every step a tool call takes, as `driven_by` on that call's evidence, and on the cleanup steps
   * an answer drains; the answer's own entry names its person by `responded_by`, never by this. A
   * label for people and replies: never compared, never a reason to refuse. A malformed value is
   * refused by the engine (`VALIDATION_ACTOR_INVALID`) on the first call. Absent ⇒ none recorded.
   */
  driver?: Attributed;
  /**
   * issue #729 PR-0 (D2 §5, D4 P-6): the operator route the program that launches this server
   * injects — `realm mcp` and `realm serve` hand the CLI's renderer, so the block of a reply addressed
   * to the person (`audience: ["user"]`) can name the command an operator runs for a way only an
   * operator can take. Never in a structured entry the model reads. The standalone `realm-mcp` bin
   * injects none: its replies name no operator command at all.
   */
  operatorRoute?: OperatorRoute;
  /**
   * #627 W (§5.1): how this server handles gate answers. `asked` (the default): in a chat app that
   * shows forms the question goes to the person in the app's own form and the agent gets no answer
   * tool; in an app without forms the agent keeps the answer tool, and the app is asked to have the
   * person approve each call. `offered`: the answer tool for any client, the agent included.
   * `withheld`: no tool records a gate answer. Read with `REALM_MCP_GATE_ANSWERS` and the bins'
   * `--gate-answers` flag; the MOST RESTRICTIVE value wins (`withheld` > `asked` > `offered`). A value
   * that is not one of the three throws (no server is built). `effectiveGateAnswers()` logs it.
   */
  gateAnswers?: 'asked' | 'offered' | 'withheld';
  /**
   * #627 W: the value of the `--gate-answers` flag, as the `realm mcp` / `realm serve` bins pass it
   * (source `flag`). An embedder uses `gateAnswers`.
   */
  gateAnswersFlag?: string;
  /**
   * #627 W (§5.2b): the longest a form waits, in whole seconds from 30 to 3600 (default 240). Read
   * with `REALM_MCP_FORM_WAIT_SECONDS` and the bins' `--form-wait-seconds`; the SMALLEST value set
   * wins. Out of bounds throws (no server is built).
   */
  formWaitSeconds?: number;
  /** #627 W: the `--form-wait-seconds` flag's value, as the bins pass it (source `flag`). */
  formWaitSecondsFlag?: string;
  /**
   * #627 W: true for a server that answers one stateless HTTP request (`realm serve`): it sends no
   * forms (the SDK 1.x HTTP transport cannot hold one open), so `asked` is its fallback.
   */
  statelessHttp?: boolean;
  /**
   * #627 W (§5.8): the principal of this server's transport, stamped on every answer it records — an
   * API key's id, `realm serve`'s shared token, or a door's typed absence. Absent ⇒
   * `principal_not_passed`. A principal a tool's caller sends is never read.
   */
  principal?: Principal;
  /** #627 W: the monotonic clock a form's per-call budget is read from (default `performance.now`). */
  monotonicNow?: () => number;
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
 * Creates and configures the Realm MCP server with its workflow tools. #627 W: which answer tool is
 * listed follows the gate-answers value and the session's forms (§5.2's table) — `submit_human_response`
 * under `offered` and on `asked`'s fallback, `present_question` under `asked` in a session whose
 * client shows forms, neither under `withheld`.
 *
 * When no `registry` is provided, `FileSystemAdapter` is pre-registered automatically
 * under the name `filesystem`. Pass a custom `registry` to add your own handlers and
 * adapters — when you do, include `FileSystemAdapter` explicitly if your workflows use it,
 * or start from `createDefaultRegistry()` and add your extensions on top.
 */
export function createRealmMcpServer(options?: RealmMcpServerOptions): McpServer {
  // #627 W (§5.1): the gate-answers value and the form wait, judged before anything is built — a
  // value that is not valid builds no server (W-s4, W-s8; library forms).
  const answersJudged = judgeGateAnswers({
    flag: options?.gateAnswersFlag,
    env: process.env[GATE_ANSWERS_ENV],
    option: options?.gateAnswers,
  });
  if (!answersJudged.ok) {
    throw new Error(gateAnswersLibraryRefusal(answersJudged.kind, answersJudged.raw));
  }
  // Correction 1 (C1, boundary-strict): the principal this door stamps is checked once, here — an
  // embedder's malformed principal refuses the server, never every answer at its write.
  if (
    options?.principal !== undefined &&
    principalOf({ principal: options.principal }) === undefined
  ) {
    throw new Error(INVALID_PRINCIPAL_OPTION);
  }
  const waitJudged = judgeFormWait({
    flag: options?.formWaitSecondsFlag,
    env: process.env[FORM_WAIT_ENV],
    option: options?.formWaitSeconds,
  });
  if (!waitJudged.ok) throw new Error(formWaitLibraryRefusal(waitJudged.raw));
  // Correction 2 (4.2): the same predicate as the bins — a form-wait value where no form is ever
  // sent (`withheld`, `offered`, or a door that sends none: `statelessHttp`) builds no server.
  const sendsForms = options?.statelessHttp !== true;
  if (
    waitJudged.setting.source.kind !== 'default' &&
    formWaitInert(answersJudged.setting.value, sendsForms)
  ) {
    const where =
      waitJudged.setting.source.kind === 'flag'
        ? '--form-wait-seconds'
        : waitJudged.setting.source.kind === 'env'
          ? FORM_WAIT_ENV
          : 'the formWaitSeconds option';
    throw new Error(
      formWaitInertLibraryRefusal(
        where,
        !sendsForms
          ? 'it sends no forms (statelessHttp)'
          : `it sends no forms under gate answers ${answersJudged.setting.value}`,
      ),
    );
  }
  const door = new McpDoor({
    gateAnswers: answersJudged.setting,
    formWait: waitJudged.setting,
    sendsForms,
    ...(options?.monotonicNow !== undefined ? { monotonicNow: options.monotonicNow } : {}),
  });

  const server = new McpServer(
    {
      name: 'realm',
      version: VERSION,
    },
    {
      // #627 W (§5.5): the client can read the value this server runs with, and where it was set
      // (the kind only — never a variable's name or value).
      capabilities: {
        experimental: {
          'realm/gate_answers': {
            value: door.gateAnswers.value,
            source_kind: door.gateAnswers.source.kind,
          },
        },
      },
    },
  );

  // issue #620 PR-C: every store a host hands realm must carry this realm's release line — checked
  // on the raw options, before any defaulting or derivation (the trace buffer derived below is this
  // package's own and needs no check).
  if (options !== undefined) {
    if (options.workflowStore !== undefined) {
      assertReleaseLine(options.workflowStore, 'the workflow store handed to createRealmMcpServer');
    }
    if (options.runStore !== undefined) {
      assertReleaseLine(options.runStore, 'the run store handed to createRealmMcpServer');
    }
    if (options.traceBufferStore !== undefined) {
      assertReleaseLine(
        options.traceBufferStore,
        'the trace buffer handed to createRealmMcpServer',
      );
    }
    if (options.failedAttemptStore !== undefined) {
      assertReleaseLine(
        options.failedAttemptStore,
        'the failed-attempt store handed to createRealmMcpServer',
      );
    }
    // A static registry is checked here too, like the stores — refused only on proof. A
    // registryProvider's result is checked per tool call, where it is resolved.
    assertRegistryLine(
      options.registry,
      'the registry handed to createRealmMcpServer',
      ExtensionRegistry,
    );
  }

  // When no registry is provided, use the default registry that pre-registers built-in
  // adapters. When a registry is provided, the caller is responsible for its contents.
  const effectiveRegistry = options?.registry ?? createDefaultRegistry();

  // Default the workflow store the same way (mirrors effectiveRegistry / effectiveRunStore). This is
  // what lets get_run_state compute next_actions on the option-less entrypoint path — without it,
  // get_run_state would silently degrade to 'workflow_unresolved'. Behaviour-preserving for every
  // other tool: start_run/start_run_batch/etc. already fall back to the same default
  // (`~/.realm/workflows`) internally, so receiving it explicitly changes nothing for them.
  const effectiveWorkflowStore = options?.workflowStore ?? new JsonWorkflowStore();

  // #627 W: the door rides every tool's stores; on stdio a form is sent through this server's own
  // `elicitInput` (bound per call, so a test client's capabilities are read at the call).
  const elicit: ElicitFn = (params, opts) =>
    server.server.elicitInput(params, opts) as ReturnType<ElicitFn>;
  const effectiveOptions = {
    ...options,
    registry: effectiveRegistry,
    workflowStore: effectiveWorkflowStore,
    door,
    elicit,
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
    // The run reader is the server's run store: every fence predicate is evaluated against it,
    // inside the trace buffer's own critical section (issue #616 PR-0).
    traceBufferStore =
      options?.traceBufferStore ?? new JsonTraceBufferStore(runsDirPath, effectiveRunStore);
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
  // issue #625 PR-2a: the one call that runs what the engine owes — beside execute_step, with its stores.
  registerAdvanceRun(server, { ...effectiveOptions, traceBufferStore });
  // #627 W (§5.2's table): the answer tool is listed on the `offered` row and on `asked`'s fallback
  // (a session whose client shows no forms — every session until `initialize` says otherwise, and
  // always on HTTP); `present_question` on `asked` with forms; neither under `withheld`.
  const value = door.gateAnswers.value;
  const answerTool =
    value === 'withheld'
      ? undefined
      : registerSubmitHumanResponse(
          server,
          effectiveOptions,
          value === 'offered' ? 'offered' : 'fallback',
        );
  const presentTool =
    value === 'asked' && door.sendsForms
      ? registerPresentQuestion(server, effectiveOptions)
      : undefined;
  presentTool?.disable();
  // issue #600 caching PR P: with no provider, the installed list only (loaded once per process).
  const priceSourceProvider =
    options?.priceSourceProvider ??
    (async (): Promise<PriceSource> =>
      withSourceNote(await loadPriceSource({}), 'no economics file is configured on this server'));
  registerGetRunState(server, { ...effectiveOptions, priceSourceProvider });
  const abandonTool = registerAbandonRun(server, effectiveOptions);
  // W-c8: where no answer tool is listed, abandon's description names none.
  if (value === 'withheld')
    abandonTool.update({ description: ABANDON_RUN_DESCRIPTION_NO_ANSWER_TOOL });
  registerCreateWorkflow(server, effectiveOptions);
  registerAppendTrace(server, {
    runStore: effectiveRunStore,
    // Correction 2 (8.6 (e)): the effective workflow store, as every other tool gets it — one instance.
    workflowStore: effectiveWorkflowStore,
    traceBufferStore,
    // #627 W (correction 1, A2): the door, as every other tool gets it from `effectiveOptions`.
    door,
    ...(options?.operatorRoute !== undefined ? { operatorRoute: options.operatorRoute } : {}),
  });

  // #627 W (§5.2b): the session's forms, negotiated at `initialize` — form elicitation declared by
  // the client (SDK 1.31 normalises `elicitation: {}` to `{ form: {} }`). Read once per session, never
  // module-level; on stateless HTTP there is no session to hold a form, so the row stays the
  // fallback. Under `asked` with forms the answer tool goes and `present_question` comes, announced
  // with `list_changed`.
  server.server.oninitialized = () => {
    const shown =
      door.sendsForms && server.server.getClientCapabilities()?.elicitation?.form !== undefined;
    door.forms = { ...door.forms, shown };
    if (value === 'asked' && shown) {
      answerTool?.disable();
      presentTool?.enable();
      abandonTool.update({ description: ABANDON_RUN_DESCRIPTION_NO_ANSWER_TOOL });
    }
    // Correction 1 (B2): the first request a server sends a client has JSON-RPC id 0, and SDK 1.31's
    // client ignores a cancel for a falsy id (`shared/protocol.js` `_oncancel`), so a session's first
    // form could never be withdrawn on such a client. A ping spends id 0; `request()` takes its id
    // synchronously, so no form can take it first. Nothing is awaited here (rail 3).
    // MCP SDK 1.x ignores a cancel for request id 0 (modelcontextprotocol/typescript-sdk#3043); remove
    // this ping when a 1.x release carries the #2654 backport, or at the SDK 2.x move (#753).
    if (shown) void server.server.ping().catch(() => undefined);
  };

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

/** Correction 1 (C1): the library refusal of a `principal` option the total reader cannot read. */
export const INVALID_PRINCIPAL_OPTION =
  "createRealmMcpServer: the principal option is not a principal — expected { kind: 'api_key', id: <a non-empty string> }, { kind: 'shared_token' }, or a typed absence such as { absent: 'door_authenticates_no_principal' }. Refused when the server is built: every answer it records would name it. Fix the option.";

/**
 * #627 W (correction 1, A4): the `realm-mcp` bin reads no flags. A flag given to it would be ignored —
 * `--gate-answers withheld` would start `asked`, the agent keeping an answer tool in apps without
 * forms, with nothing said — so any argument refuses the start, with one line and exit code 1
 * (correction 2, 4.5/4.6: the line names both variables, and this comment is the constant's own).
 */
export const REALM_MCP_TAKES_NO_FLAGS =
  "realm-mcp takes no flags: set REALM_MCP_GATE_ANSWERS or REALM_MCP_FORM_WAIT_SECONDS in your MCP client's env block, or run realm mcp with the flag.";

if (isRunDirectly() && process.argv.length > 2) {
  console.error(REALM_MCP_TAKES_NO_FLAGS);
  process.exit(1);
}

if (isRunDirectly()) {
  // Correction 2 (4.1): the variables judged as `realm mcp` judges its flags — a refusal is one line
  // naming the variable and exit 1, never a stack trace; then the start line, on stderr (stdout
  // carries the protocol), before anything is built.
  const settings = readBinDoorSettings('realm-mcp', {}, process.env);
  if (!settings.ok) {
    console.error(settings.line);
    process.exit(1);
  }
  // This program's name, which may itself refuse with one line — then no start line is printed.
  const driver = composeBinIdentity();
  console.error(gateAnswersStartLine(settings.answers, false, 'realm-mcp'));
  // #627 W (§5.8): the stdio transport authenticates no one, so this bin's answers name no principal.
  const server = createRealmMcpServer({
    ...(driver !== undefined ? { driver } : {}),
    principal: { absent: 'door_authenticates_no_principal' },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
