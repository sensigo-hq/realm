// realm-mcp — MCP server exposing the Realm workflow engine to AI agents. The library: importing it
// starts nothing. The `realm-mcp` program is `bin.ts` (#616 PR-2a, unit ii-a).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ExtensionRegistry,
  type WorkflowRegistrar,
  withTestClockNotice,
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
  type RunRecord,
} from '@sensigo/realm';
import type { PriceSource, WorkflowDefinition } from '@sensigo/realm';
import { discloseByTable, type DisclosureClass, type DisclosureSet } from '@sensigo/realm';
import { loadPriceSource, withSourceNote } from './price-source.js';
import { VERSION } from './version.js';
import { registerListWorkflows } from './tools/list-workflows.js';
import { registerGetWorkflowProtocol } from './tools/get-workflow-protocol.js';
import { registerStartRun } from './tools/start-run.js';
import type { FailedAttemptStoreLike } from './tools/start-run.js';
import { STORE_ORDER, joinStoreNames, type StoreName } from './tools/assert-tool-stores.js';
import { registerAdvanceRun } from './tools/advance-run.js';
import { registerExecuteStep } from './tools/execute-step.js';
import { registerSubmitHumanResponse } from './tools/submit-human-response.js';
import { registerGetRunState } from './tools/get-run-state.js';
import { registerAbandonRun } from './tools/abandon-run.js';
import { registerCreateWorkflow } from './tools/create-workflow.js';
import { registerAppendTrace } from './tools/append-trace.js';
import { registerStartRunBatch } from './tools/start-run-batch.js';
import { doorDisclosureOf, type DoorDisclosure, type OperatorRoute } from './render-reply.js';
import { registerPresentQuestion } from './tools/present-question.js';
import { ABANDON_RUN_DESCRIPTION_NO_ANSWER_TOOL } from './tools/abandon-run.js';
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
  /**
   * #616 PR-2a (ii-b): the four stores are required — the library has no default store. A
   * JavaScript caller that omits one is refused at construction, before anything is opened
   * (`VALIDATION_OPTION_INVALID`, naming every missing store). Open them once per process; the
   * `realm-mcp` command opens `~/.realm` itself.
   *
   * The workflow registry: any `WorkflowRegistrar` (#661; before #616 PR-2c c5a, a
   * `JsonWorkflowStore`). `list_workflows` also names each registered copy it could not read when the
   * registry has `listWithDiagnostics`, as Realm's own registries do; a registry without it is listed
   * as its `list()` returns. Its release line is checked at construction, as every store's is.
   */
  workflowStore: WorkflowRegistrar;
  /**
   * Run store. Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only).
   *
   * **Co-location contract with `traceBufferStore` / `failedAttemptStore` below:** the run store
   * and the trace-buffer / failed-attempt artifact stores MUST share ONE reachability domain.
   * `append_trace` writes a WAL that `execute_step` reads back at finalization, and the
   * failed-attempt sidecar is looked up the same way — if the run store and the artifact stores
   * point at DIFFERENT backing domains (e.g. a cloud run store paired with a locally-derived
   * trace buffer, or vice versa), traces and sidecar entries are silently lost: nothing will ever
   * look in the same place twice. The caller passes all four and guarantees the co-location: for the
   * file stores, the trace buffer and the failed-attempt store on the run store's own folder
   * (`new JsonTraceBufferStore(runStore.runsDirPath, runStore)`,
   * `new JsonFileFailedAttemptStore(runStore.runsDirPath)`); for a cloud run store, both backed by
   * its own database or bucket. `createRealmMcpServer` does not and cannot verify it.
   */
  runStore: RunStore;
  /**
   * Trace-buffer WAL store for incremental agent-trace ingestion (B-lite). Object injection, not
   * a path string — a Postgres/object-storage-backed run store has no filesystem directory to
   * derive one from. See the co-location contract on `runStore` above. Its run reader must read the
   * same runs as `runStore`: the fenced writes are checked against the trace buffer's own reader
   * (issue #616), never against `runStore`.
   */
  traceBufferStore: TraceBufferStore;
  /**
   * Durable per-run failed-attempt sidecar store (observability P3). Object injection — see the
   * co-location contract on `runStore` above.
   */
  failedAttemptStore: FailedAttemptStoreLike;
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
   * #729 PR-3 (M-3): the disclosure set for a reply — the declared values of the definition's
   * project and the environment's — built per reply by the host. `realm mcp` and `realm serve` pass
   * the CLI's set, declared part included. Absent ⇒ the environment's set, read per reply, with the
   * declared part `unknown` (cause `embedder_none`); a provider that throws gives the environment's
   * set with cause `load_failed`. Every reply carries its receipt. It receives what the reply is
   * about (D-11): the definition, and the run when the call names one; it reports that project's
   * declared state and cause, and keeps its declared members one process-wide union.
   */
  disclosureProvider?: (
    definition: WorkflowDefinition | undefined,
    run?: RunRecord,
  ) => Promise<DisclosureSet>;
  /** #729 PR-3 (M-3): environment variable names the host shows (with `REALM_NOT_SECRET`). */
  disclosure?: { notSecret?: string[] };
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
 * #729 PR-3 (M-5; RECORD 01 #10): the elicitation request's class table. The message is what the
 * person is asked (the declared tier); the mode and the schema — the choices — are facts: the
 * choices are acts, never masked.
 */
/**
 * Z3 (the zod 4 unit): the most array elements and object members, counted together and at every
 * depth, that one `tools/call`'s arguments may hold. The MCP SDK counts them over the raw arguments
 * BEFORE any schema runs and refuses a larger call with its own text (`maxToolInputElements`), so no
 * schema can forget the bound.
 *
 * Which zod validates what: every tool's arguments are parsed by the zod that built its schema — the
 * SDK reads `_zod` and, for zod 4 schemas (all of realm's), runs `zod/v4-mini`'s `safeParseAsync`,
 * the fixed code of zod 4.6.6+ (GHSA-mrhx-c7xc-m3w5). The five arrays carry a leading `.max`, so an
 * over-long one is refused before its elements are parsed; a record has no size check of its own,
 * and this cap is its bound. The legacy `zod/v3` entry zod 4 still ships is unfixed, and the lint
 * rule refuses importing it. The SDK's own protocol envelope is validated by its `zod/v4` types.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 50_000;

export const ELICIT_TABLE = {
  mode: 'fact',
  message: 'question',
  requestedSchema: 'fact',
} as const satisfies Record<keyof Parameters<ElicitFn>[0], DisclosureClass>;

/**
 * The ONE wrapper around `elicitInput` (M-5): the request walked by {@link ELICIT_TABLE} with the
 * definition's set, then sent. Whichever of W and PR-3 lands second binds W's `elicit` through it.
 */
export function elicitDisclosedWith(elicit: ElicitFn, door: DoorDisclosure): DisclosedElicit {
  return async (params, options, context) => {
    const set = await door.setFor(context.definition, context.run);
    const shown = discloseByTable(params, ELICIT_TABLE, set, 'agent')
      .value as Parameters<ElicitFn>[0];
    return elicit(shown, options);
  };
}

/** The send a form path holds (M-5): W's `ElicitFn`, plus what the question is about. */
export type DisclosedElicit = (
  params: Parameters<ElicitFn>[0],
  options: Parameters<ElicitFn>[1],
  context: { definition?: WorkflowDefinition; run?: RunRecord },
) => ReturnType<ElicitFn>;

/**
 * Returns an ExtensionRegistry pre-populated with Realm's built-in adapters.
 * `FileSystemAdapter` is registered under the name `'filesystem'`.
 *
 * Use this as a starting point when you need to add your own handlers or adapters on top:
 * ```ts
 * const registry = createDefaultRegistry();
 * registry.register('handler', 'my_handler', myHandler);
 * const server = createRealmMcpServer({ runStore, workflowStore, traceBufferStore, failedAttemptStore, registry });
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
export function createRealmMcpServer(options: RealmMcpServerOptions): McpServer {
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

  // issue #620 PR-C: every store a host hands realm must carry this realm's release line — checked
  // on the raw options. #616 PR-2a (ii-b): a `null` store is "not given" (as core reads one), so it
  // passes this block and meets the missing-store refusal below, never the release-line sentence.
  if (options != null) {
    if (options.workflowStore != null) {
      assertReleaseLine(options.workflowStore, 'the workflow store handed to createRealmMcpServer');
    }
    if (options.runStore != null) {
      assertReleaseLine(options.runStore, 'the run store handed to createRealmMcpServer');
    }
    if (options.traceBufferStore != null) {
      assertReleaseLine(
        options.traceBufferStore,
        'the trace buffer handed to createRealmMcpServer',
      );
    }
    if (options.failedAttemptStore != null) {
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

  // #616 PR-2a (ii-b): the library has no default store. A caller (JavaScript, or TypeScript past a
  // cast) that gives fewer than the four is refused here — after the door, principal, form-wait and
  // release-line checks, in their order — naming every missing store, before any store is read or
  // any server object exists. Option names only: never a value or a path from the environment.
  const missing: StoreName[] = STORE_ORDER.filter((name) => options?.[name] == null);
  if (missing.length > 0) {
    const what =
      options == null ? 'no options were given' : `no ${joinStoreNames(missing)} was given`;
    throw new WorkflowError(
      `createRealmMcpServer: ${what}. The library has no default store, so no server was built and nothing was opened. Pass runStore, workflowStore, traceBufferStore and failedAttemptStore, opened once per process — the file stores are new JsonFileStore(), new JsonWorkflowStore(), new JsonTraceBufferStore(runStore.runsDirPath, runStore) and new JsonFileFailedAttemptStore(runStore.runsDirPath) — or run the realm-mcp command, which opens ~/.realm itself.`,
      {
        code: 'VALIDATION_OPTION_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
        details: { missing },
      },
    );
  }

  const server = new McpServer(
    {
      name: 'realm',
      version: VERSION,
    },
    {
      // Z3 (the zod 4 unit): the whole-call element cap, counted before any schema runs.
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
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

  // When no registry is provided, use the default registry that pre-registers built-in
  // adapters. When a registry is provided, the caller is responsible for its contents.
  const effectiveRegistry = options?.registry ?? createDefaultRegistry();

  // #616 PR-2a (ii-b): the workflow store is the caller's; there is no default.
  const effectiveWorkflowStore = options.workflowStore;

  // #729 PR-3 (M-3): every reply's set comes from one door disclosure, per reply.
  const doorDisclosure: DoorDisclosure = doorDisclosureOf(options);
  // #627 W: the door rides every tool's stores; on stdio a form is sent through this server's own
  // `elicitInput` (bound per call, so a test client's capabilities are read at the call). #729 PR-3
  // (M-5, F8): the raw elicit leaves only through `elicitDisclosedWith`, which walks the request by
  // its class table with the set for the question's workflow.
  const elicit = elicitDisclosedWith(
    (params, opts) => server.server.elicitInput(params, opts) as ReturnType<ElicitFn>,
    doorDisclosure,
  );
  // Shared trace buffer store: one instance used by both append_trace and execute_step so
  // WAL entries written by append_trace are visible when execute_step finalizes the step. #729 PR-3
  // correction 2 (E-10): it rides `effectiveOptions` too, so every reply reads its run from the same
  // store — the masking's subject (`replySubject`) included, on a fresh process's first call.
  // #715 (b) (02 §C.3, D6-53): a store at a test location says so once per process on stderr (the
  // MCP stdio transport's free channel), at its first read.
  const effectiveRunStore: RunStore = withTestClockNotice(options.runStore, (line) => {
    process.stderr.write(`${line}\n`);
  });
  const effectiveOptions = {
    ...options,
    registry: effectiveRegistry,
    workflowStore: effectiveWorkflowStore,
    runStore: effectiveRunStore,
    doorDisclosure,
    door,
    elicit,
  };

  // issue #188, PR-1: the co-location seam (the doc comment on `runStore` above). #616 PR-2a (ii-b):
  // the caller passes both artifact stores, co-located with its run store; nothing is derived.
  const traceBufferStore: TraceBufferStore = options.traceBufferStore;
  const failedAttemptStore: FailedAttemptStoreLike = options.failedAttemptStore;

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
    doorDisclosure,
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
