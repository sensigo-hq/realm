// start-run tool — creates a new run and runs its first automatic steps (advanceRun).
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  validateRunParams,
  JsonWorkflowStore,
  JsonFileStore,
  advanceRun,
  classifyStop,
  endedRunWaysSentence,
  composeWaysOn,
  writtenSnapshot,
  hashParams,
  WorkflowError,
  buildPreExecutionErrorEnvelope,
  unmetCapabilities,
  capabilityWarning,
  createDefaultRegistry,
  deriveRunPhase,
  type EngineReply,
  type RunStore,
  type TraceBufferStore,
  type FailedAttemptStore,
  ExtensionRegistry,
  type Attributed,
  type Principal,
  type RunRecord,
  type WorkflowDefinition,
  type DisclosureClass,
  persistsField,
  startIdentityEntry,
} from '@sensigo/realm';
import type { McpDoor } from '../door.js';
import { withQuestionForm, type FormCall, type FormDeps } from '../form-path.js';
import type { DisclosedElicit } from '../server.js';
import { toolMeta } from '../tool-annotations.js';
import { assertToolStores, markServedByTool, registryRole } from './assert-tool-stores.js';
import {
  disclosureOfTool,
  mcpReplyOf,
  withHintTail,
  renderReply,
  safeTool,
  toolContentOf,
  MCP_ENVELOPE_TABLE,
  type WithDoorDisclosure,
  type McpEnvelope,
  type McpHost,
  type OperatorRoute,
  type WithPersonBlock,
  replySubject,
  setForSubject,
  SAFE_TOOL_CONSTANT_RUNLESS,
} from '../render-reply.js';

/**
 * issue #729 PR-0: the ways of a record a tool hands back, composed by core's one composer
 * (`composeWaysOn`) from the record as the tool last read or wrote it, at the tool's reading — this
 * server's registry, or none (an observer, C33). The tools compose; the renderer only renders.
 */
export function composeToolWays(
  runStore: Pick<RunStore, 'persistsClaims'>,
  definition: WorkflowDefinition,
  run: RunRecord,
  registry: ExtensionRegistry | undefined,
  at: Date,
): Pick<EngineReply, 'ways' | 'unavailable' | 'basis'> {
  return composeWaysOn(writtenSnapshot(run, at), {
    definition: { ok: definition },
    enactor: registry !== undefined ? { kind: 'this_program', registry } : { kind: 'observer' },
    store: { persistsClaims: runStore.persistsClaims === true },
  });
}

/**
 * The MCP host of a tool's stores: the operator route the launching program injected, if any, and
 * (#627 W) this server's door — its gate answers and its form facts, read at the call (the session's
 * forms are negotiated after construction).
 */
export function mcpHostOf(
  stores: Pick<HandleRunStores, 'operatorRoute' | 'door'> | undefined,
): McpHost {
  const door = stores?.door;
  return {
    ...(stores?.operatorRoute !== undefined ? { operatorRoute: stores.operatorRoute } : {}),
    ...(door !== undefined
      ? { answers: door.answers(), formFacts: (gateId: string) => door.formFacts(gateId) }
      : {}),
  };
}

/** #627 W (§5.8): the principal a tool's answers record — the door's, else the library's absence. */
export function principalOfStores(
  stores: Pick<HandleRunStores, 'principal'> | undefined,
): Principal {
  return stores?.principal ?? { absent: 'principal_not_passed' };
}

/**
 * #627 W: what sending a form needs on this call, or `undefined` when this server sends none (no
 * door, or no way to send — a stateless HTTP door).
 */
export function formDepsOf(
  stores: HandleRunStores | undefined,
  runStore: RunStore,
  definition: WorkflowDefinition,
  registry: ExtensionRegistry | undefined,
): FormDeps | undefined {
  if (stores?.door === undefined || stores.elicit === undefined || !stores.door.sendsForms) {
    return undefined;
  }
  const elicit = stores.elicit;
  return {
    door: stores.door,
    elicit: (params, options, run) => elicit(params, options, { definition, run }),
    runStore,
    definition,
    ...(registry !== undefined ? { registry } : {}),
    ...(stores.driver !== undefined ? { driver: stores.driver } : {}),
    principal: principalOfStores(stores),
  };
}

/** #627 W: one tool call's own facts — its cancel signal and its start, on the door's clock. */
export function formCallOf(
  stores: Pick<HandleRunStores, 'door'> | undefined,
  extra: { signal?: AbortSignal; requestId?: string | number } | undefined,
): FormCall | undefined {
  if (stores?.door === undefined) return undefined;
  return {
    started: stores.door.monotonicNow(),
    ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
    // Correction 1 (B9): the call's own request id, so its form rides the call's stream.
    ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
  };
}
import { assertRegistryLine, ExtensionRegistry as RealmExtensionRegistry } from '@sensigo/realm';

/**
 * The hint of a reply that hands back a run on which this call ran nothing (decisions C45, C57, C64,
 * C65): `Run '<id>' created for workflow '<wf>'.` (with the supersede clause when the run replaced
 * another), or `Matched existing run '<id>' (idempotent) in phase '<phase>'; no new run created.`
 * for a run an idempotency key matched. #729 PR-0 (Part B, A-10): what comes next on a live run is
 * no longer composed here — the reply carries the ways and `names_next`, and the renderer says it;
 * the ended-run half (`endedRunWaysSentence`, PR-1's verbs) stays until PR-1. `start_run`'s reply
 * and every `started` entry of `start_run_batch` carry it; neither composes its own.
 *
 * @param run      The record the store returned: the run created, or the one the key matched.
 * @param current  The record the reply describes — `run`, or the one a capability block's attempt
 *                 left (decision C52).
 */
export function handBackHint(args: {
  run: RunRecord;
  current: RunRecord;
  definition: WorkflowDefinition;
  deduped: boolean;
}): string {
  const { run, current, definition, deduped } = args;
  if (deduped) {
    // decisions C205, C211: a matched run that has ended says the ways back in.
    return `Matched existing run '${run.id}' (idempotent) in phase '${deriveRunPhase(run)}'; no new run created.${endedRunWaysSentence(current, definition, new Date())}`;
  }
  return run.rerun_of !== undefined
    ? `Run '${run.id}' created for workflow '${definition.id}'; it supersedes run '${run.rerun_of}' under the same idempotency key (on_terminal_match).`
    : `Run '${run.id}' created for workflow '${definition.id}'.`;
}

/** Lightweight structured telemetry. stderr is safe under the MCP stdio/SSE transport. */
function logDedup(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: 'idempotency_dedup', ...fields }));
}

/**
 * Structural (not nominal) shape of `FailedAttemptStore`'s public surface, derived via `Pick` so a
 * duck-typed cloud-backed object can satisfy it too — the concrete `FailedAttemptStore` class has
 * a private `runsDir` field, so a plain object literal implementing these methods could never be
 * assignable to the class type itself (issue #188, PR-1: the co-location injection seam). Used
 * anywhere a `FailedAttemptStore`-like store is threaded through as an injectable option.
 */
export type FailedAttemptStoreLike = Pick<
  FailedAttemptStore,
  'append' | 'read' | 'deleteAllForRun' | 'listOrphans'
>;

export interface HandleRunStores {
  /** Run store. Any `RunStore` implementation (issue #188, PR-1 — was `JsonFileStore`-only). */
  runStore?: RunStore;
  workflowStore?: JsonWorkflowStore;
  /** Extension registry for resolving service adapters and step handlers. */
  registry?: ExtensionRegistry;
  /**
   * Per-definition registry resolution (project extensions). Awaited BEFORE `runStore.create`
   * (a throwing provider means no run is created) and before execution in execute_step.
   * Wins over `registry` when both are supplied.
   */
  registryProvider?: (
    definition: import('@sensigo/realm').WorkflowDefinition,
  ) => Promise<ExtensionRegistry>;
  /** Trace buffer store for incremental WAL-based trace ingestion (B-lite). */
  traceBufferStore?: TraceBufferStore;
  /** Durable per-run sidecar for failed agent-attempt telemetry (observability P3). */
  failedAttemptStore?: FailedAttemptStoreLike;
  /**
   * Issue #625 (holder slice): the host PROGRAM this server runs as — its name, how that name is
   * known, and its channel. Written as `holder` on the claim of every step a tool call takes and
   * as `driven_by` on that call's evidence, and on the cleanup steps an answer drains. A label,
   * never compared, never a reason to refuse. Absent ⇒ none recorded.
   */
  driver?: Attributed;
  /**
   * issue #729 PR-0 (D2 §5, P-6): the operator route the launching program injected — `realm mcp`
   * and `realm serve` hand the CLI's renderer, so the block addressed to the person can name an
   * operator's command; the standalone `realm-mcp` bin injects none.
   */
  operatorRoute?: OperatorRoute;
  /**
   * #627 W: this server's MCP door — its gate answers (value, source, the session's forms), its form
   * wait and the per-gate form facts of this process. Set by `createRealmMcpServer`; absent ⇒ the
   * tools narrow as PR-0 did.
   */
  door?: McpDoor;
  /** #627 W: how this server sends a form (its `elicitInput`), when it can. #729 PR-3 (M-5): the
   *  send is `elicitDisclosedWith`'s, so a form's text is walked with the question's workflow's set. */
  elicit?: DisclosedElicit;
  /**
   * #627 W (§5.8): the principal of this server's transport, stamped on every answer it records —
   * `realm serve`'s shared token, a door's typed absence, or an embedder's API key. Absent ⇒
   * `principal_not_passed`. Never one a tool's caller sends.
   */
  principal?: Principal;
}

/**
 * Business logic for the start_run tool.
 * Creates a run and immediately chains through any leading auto steps.
 */
export async function handleStartRun(
  args: {
    workflow_id: string;
    params?: Record<string, unknown>;
    idempotency_key?: string | undefined;
    on_terminal_match?: 'reuse' | 'reject' | 'rerun_if_failed' | 'rerun' | undefined;
    on_live_match?: 'use_existing' | 'fail' | undefined;
  },
  stores?: HandleRunStores,
  call?: FormCall,
): Promise<WithPersonBlock<McpEnvelope> & { deduped: boolean; rerun_of?: string }> {
  assertToolStores(stores, 'handleStartRun');
  const workflowStore = stores?.workflowStore ?? new JsonWorkflowStore();
  const runStore = stores?.runStore ?? new JsonFileStore();
  const definition = await workflowStore.get(args.workflow_id);
  const params = args.params ?? {};

  // issue #586: a declared `params_schema` is applied on EVERY run-creation surface. This throw is
  // the tool's ordinary WorkflowError envelope and it lands BEFORE `runStore.create` below, so a
  // violating call creates no run and never reaches the idempotency re-encounter branch.
  if (definition.params_schema !== undefined) {
    validateRunParams(params, definition.params_schema, definition.id);
  }

  // Resolve the effective registry BEFORE run creation — a throwing registryProvider must
  // fail this tool call with NO run created. Provider wins over construction-time registry.
  const registry =
    stores?.registryProvider !== undefined
      ? await stores.registryProvider(definition)
      : stores?.registry;
  // issue #620 PR-C: the registry rule — refused only on proof (another realm version), before any
  // write. Covers the provider's result and the construction-time registry alike.
  assertRegistryLine(
    registry,
    registryRole(stores, 'start_run', 'handleStartRun'),
    RealmExtensionRegistry,
  );

  const { run, created } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: definition.version,
    params,
    ...(args.idempotency_key !== undefined ? { idempotencyKey: args.idempotency_key } : {}),
    ...(args.on_terminal_match !== undefined ? { onTerminalMatch: args.on_terminal_match } : {}),
    ...(args.on_live_match !== undefined ? { onLiveMatch: args.on_live_match } : {}),
    // #729 PR-3 correction 5 (J-5): the run is born with the serving program's identity, the
    // manifest reference included; a registry with no identity (a bare server) writes none.
    ...(startIdentityEntry(registry) !== undefined && persistsField(runStore, 'extension_identity')
      ? { extensionIdentity: [startIdentityEntry(registry)!] }
      : {}),
  });
  // The store reports `created`; the tool surfaces its inverse, `deduped`.
  const deduped = !created;
  // issue #279 (increment 2, PR-C — D-3 leg vi): the start_run REUSE surfaces — a deduped match
  // can hit a GRANDFATHERED terminal-with-stale-gate record (the #282 class), never a freshly
  // created one, so this is where the persisted `run_phase` can actually be stale.
  const derivedPhase = deriveRunPhase(run);

  // #134 pre-flight (WARN-only, never refuse): if the effective registry can't satisfy the workflow's
  // auto-step handlers/adapters, warn so the operator can provision before a step blocks recoverably.
  // The `?? createDefaultRegistry()` fallback is a HARD invariant — it mirrors the dispatch sites, so a
  // filesystem-only workflow with no supplied registry does not false-warn.
  const unmet = unmetCapabilities(definition, registry ?? createDefaultRegistry());
  const warnings: string[] = unmet.map(capabilityWarning);
  if (deduped) {
    // Observational only — a legitimate same-caller retry also hits an active run. Keyed on
    // terminal_state, never the persisted run_phase.
    if (!run.terminal_state) {
      warnings.push(`Idempotency key matched a run still in phase '${derivedPhase}'.`);
    }
    // PR 1 warns on a key↔payload mismatch; PR 2 may make this policy.
    if (args.idempotency_key !== undefined && hashParams(params) !== hashParams(run.params)) {
      warnings.push(
        `Idempotency key matched an existing run created with different params; the original run is returned unchanged (params not updated).`,
      );
    }
    // issue #279 (increment 1, PR-B), design record §6: pending-drain is DISCLOSURE ONLY here —
    // it never feeds decideIdempotencyPolicy's own decision (that pure function's domain is
    // unchanged); a 'reuse' match on a terminal run with undelivered finalizers just gets one
    // extra advisory line pointing at the recovery verb.
    const pendingFinalizerCount = Object.values(run.finalizer_ledger ?? {}).filter(
      (e) => e.status === 'pending',
    ).length;
    if (run.terminal_state && pendingFinalizerCount > 0) {
      warnings.push(
        `completion recorded; ${pendingFinalizerCount} finalizer(s) not yet delivered — realm run drain ${run.id}`,
      );
    }
    logDedup({
      tool: 'start_run',
      workflow_id: definition.id,
      run_id: run.id,
      run_phase: derivedPhase,
    });
  }

  // issue #625 PR-2a (decision C1): ONLY the creating call runs work. A deduped match runs nothing
  // — an idempotent create has no side effect on a match — and its reply names what the run owes
  // (the agent steps, the advance act) through `buildNextActions` below.
  // decision C52: the record the creation reply is composed from — the created record, or the one a
  // capability block left (its attempt wrote the marker and an entry).
  let createdRun = run;
  let capabilityBlock: EngineReply | undefined;
  if (!deduped) {
    const result = await advanceRun(runStore, definition, {
      runId: run.id,
      caller: 'start_run',
      ...(registry !== undefined ? { registry } : {}),
      ...(stores?.traceBufferStore !== undefined
        ? { traceBufferStore: stores.traceBufferStore }
        : {}),
      ...(stores?.driver !== undefined ? { driver: stores.driver } : {}),
    });
    const ranSomething =
      result.status !== 'ok' ||
      result.chained_auto_steps !== undefined ||
      result.run_version !== run.version;
    // decision C52: a capability block is not this call's failure — the run was created and is
    // healthy; a runner with the extension runs the step. The reply is the creation reply (status
    // ok), its hint names the step through describeNext, and the block's message (its own
    // `context_hint`: "Step '<s>' is blocked: …") rides in `warnings`, in place of that step's
    // pre-flight warning (decision C58). A failed step is returned as is.
    // F7: the reply read by core's classifier (one rule for every host — no code list here).
    const afterAdvance =
      result.status === 'error' ? await runStore.get(run.id).catch(() => run) : undefined;
    if (
      afterAdvance !== undefined &&
      classifyStop(result, undefined, afterAdvance)?.kind === 'capability_missing'
    ) {
      capabilityBlock = result;
      createdRun = afterAdvance;
    } else if (ranSomething) {
      // decision C10: the phase is derived from the record advanceRun leaves.
      const finalRun = await runStore.get(run.id).catch(() => run);
      // decisions C205, C211 (the architect's addendum): a run this call ended — its own step
      // failed, or cleanup steps were left pending — says the ways back in.
      const ranReply: EngineReply = {
        ...result,
        run_id: run.id,
        data: {},
        evidence: [],
        run_phase: deriveRunPhase(finalRun),
        warnings: [...result.warnings, ...warnings],
        // issue #558 PR-C (walk): a superseding run says so in the response that created it — the
        // agent should not need a second call to learn that `on_terminal_match: 'rerun'` replaced
        // a run.
        ...(finalRun.rerun_of !== undefined ? { rerun_of: finalRun.rerun_of } : {}),
      };
      // walk 2: the hint is what an agent reads first; a supersede must be said there, not only
      // carried as a key below the next_actions block. It, or the ended run's ways back in, follow
      // the door's next sentence, as before #729 PR-0.
      // #627 W (§5.2b): the run this call created reached a question — its form is sent here.
      const after = await withQuestionForm(
        ranReply,
        formDepsOf(stores, runStore, definition, registry),
        call,
      );
      // Correction 1 (B7): the ended run's ways back in are read from the record as it stands after
      // the form's wait — a run that ended during the form gets them.
      const afterRun =
        after === ranReply ? finalRun : await runStore.get(run.id).catch(() => finalRun);
      const tail =
        finalRun.rerun_of !== undefined
          ? ` This run supersedes run '${finalRun.rerun_of}' under the same idempotency key (on_terminal_match).`
          : endedRunWaysSentence(afterRun, definition, new Date());
      return {
        ...mcpReplyOf(withHintTail(renderReply(after, mcpHostOf(stores)), tail)),
        deduped,
      };
    }
  }

  // decision C95: with the clock, a run the key matched whose open question is due (its time is up,
  // `on_expiry` declared) is handed back with the `advance_run` act that carries it out.
  const now = new Date();
  // decision C58: the block happened, so the pre-flight warning for the same step ("If reached it
  // will block") is dropped beside it. The blocked steps are the ones whose `capability_blocks`
  // marker this call's attempt wrote — a created run carries none before it.
  const blockedHere =
    capabilityBlock === undefined
      ? new Set<string>()
      : new Set(
          Object.keys(createdRun.capability_blocks ?? {}).filter(
            (step) => run.capability_blocks?.[step] === undefined,
          ),
        );
  const droppedPreflight = new Set(
    unmet.filter((requirement) => blockedHere.has(requirement.step)).map(capabilityWarning),
  );
  const handBack: EngineReply = {
    command: 'start_run',
    run_id: run.id,
    run_version: createdRun.version,
    status: 'ok',
    reply_kind: 'ok',
    data: {},
    evidence: [],
    warnings:
      capabilityBlock !== undefined
        ? [...warnings.filter((w) => !droppedPreflight.has(w)), capabilityBlock.context_hint]
        : warnings,
    errors: [],
    ...(capabilityBlock?.chained_auto_steps !== undefined
      ? { chained_auto_steps: capabilityBlock.chained_auto_steps }
      : {}),
    // issue #625 PR-2a (decisions C45, C57, C64): a run this call ran nothing on — created, or
    // matched by its key — says what comes next in its own hint, so a step that cannot run, and the
    // way out when the run cannot go on, are named on the reply that hands the run back.
    context_hint: handBackHint({ run, current: createdRun, definition, deduped }),
    run_phase: deriveRunPhase(createdRun),
    ...(run.rerun_of !== undefined ? { rerun_of: run.rerun_of } : {}),
    ...composeToolWays(runStore, definition, createdRun, registry, now),
    // decisions C45, C57, C64: the hand-back says what comes next on a live run (the renderer's).
    ...(createdRun.terminal_state ? {} : { names_next: true as const }),
  };
  // #627 W (§5.2b; correction 1, B10): a hand-back sends no form. A created run reaches a question only
  // by running a step — the branch above sends that form — and a deduped match never sends one.
  return { ...mcpReplyOf(renderReply(handBack, mcpHostOf(stores))), deduped };
}

/** start_run's reply: the envelope, whether the call matched a run, and which run it reran. */
export type StartRunReply = McpEnvelope & { deduped: boolean; rerun_of?: string };

/** #729 PR-3 (M-1): start_run's reply is the envelope plus whether the call matched a run, and
 *  which run it reran. */
export const START_RUN_TABLE = {
  ...MCP_ENVELOPE_TABLE,
  deduped: 'fact',
  rerun_of: 'fact',
} as const satisfies Record<keyof StartRunReply, DisclosureClass>;

/** Registers the start_run MCP tool on the server. */
export function registerStartRun(
  server: McpServer,
  opts?: HandleRunStores & WithDoorDisclosure,
): void {
  markServedByTool(opts);
  const door = disclosureOfTool(opts);
  server.registerTool(
    'start_run',
    {
      ...toolMeta('start_run'),
      description: 'Create a new workflow run and run its first automatic steps.',
      inputSchema: {
        workflow_id: z.string(),
        params: z.record(z.unknown()).optional().default({}),
        idempotency_key: z.string().optional(),
        on_terminal_match: z.enum(['reuse', 'reject', 'rerun_if_failed', 'rerun']).optional(),
        on_live_match: z.enum(['use_existing', 'fail']).optional(),
      },
    },
    safeTool(
      async (args, extra) => {
        const result = await handleStartRun(args, opts, formCallOf(opts, extra));
        // Override command to 'start_run': MCP callers invoked start_run, not the first auto step
        // executeChain may have run. The step a non-ok reply belongs to stays named in
        // `stopped_step` (issue #676 review).
        return toolContentOf(
          { ...result, command: 'start_run' },
          {
            set: await setForSubject(
              door,
              await replySubject(opts, { runId: result.run_id, workflowId: args.workflow_id }),
            ),
            audience: 'agent',
            table: START_RUN_TABLE,
          },
        );
      },
      async (err, args) => {
        const workflowErr =
          err instanceof WorkflowError
            ? err
            : new WorkflowError(err instanceof Error ? err.message : String(err), {
                code: 'ENGINE_INTERNAL',
                category: 'ENGINE',
                agentAction: 'stop',
                retryable: false,
              });
        const contextHint =
          workflowErr.code === 'STATE_WORKFLOW_NOT_FOUND'
            ? `Workflow '${args.workflow_id}' not found.`
            : `An error occurred before the run could be started.`;
        const rendered = renderReply(
          buildPreExecutionErrorEnvelope('start_run', '', 0, workflowErr, contextHint),
          mcpHostOf(opts),
        );
        return toolContentOf(mcpReplyOf(rendered), {
          set: await setForSubject(
            door,
            await replySubject(opts, { workflowId: args.workflow_id }),
          ),
          audience: 'agent',
          table: MCP_ENVELOPE_TABLE,
        });
      },
      SAFE_TOOL_CONSTANT_RUNLESS,
    ),
  );
}
