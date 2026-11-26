// caller-limits.ts — #625 named keys unit 2: the limits a caller's key (or an embedding program's
// `limits` option) puts on what it may call, and the one check every tool runs first.
//
// A limit is a tool list (`readOnly`, the reading tools; or `tools`) and a workflow list
// (`workflows`). The check runs before the tool does anything: the tool first, then what the call
// names — its workflow, or its run's workflow, read from the run's record and nothing else (never the
// run's definition or its project's `realm.yaml`). A refusal is rendered with the door's set for no
// subject, so a missing run, another workflow's run and a run that cannot be read give the same
// reply bytes: the refusal tells a limited caller nothing about runs it may not reach.
import {
  buildPreExecutionErrorEnvelope,
  capText,
  WorkflowError,
  type RunStore,
} from '@sensigo/realm';
import type { McpDoor } from '../door.js';
import {
  disclosureOfTool,
  logMasked,
  MCP_ENVELOPE_TABLE,
  renderReply,
  safeTool,
  SAFE_TOOL_CONSTANT_RUNLESS,
  toolContentOf,
  toolContentWithTwinOf,
  type OperatorRoute,
  type ToolResult,
  type TwinFloor,
  type WithDoorDisclosure,
} from '../render-reply.js';
import { READING_TOOLS, TOOL_ANNOTATIONS, type ToolName } from '../tool-annotations.js';
import { mcpHostOf } from './start-run.js';

/** A caller's limits, as `RealmMcpServerOptions.limits` takes them. */
export interface CallerLimits {
  readonly caller: string;
  readonly readOnly?: true;
  readonly tools?: readonly string[];
  readonly workflows?: readonly string[];
}

/** The option every tool registration reads its caller's limits from. */
export interface WithCallerLimits {
  limits?: CallerLimits;
}

/** What the check reads: the limits, the run store (a run's record only) and the door. */
type LimitStores = WithCallerLimits &
  WithDoorDisclosure & { runStore?: RunStore; door?: McpDoor; operatorRoute?: OperatorRoute };

const LIMITS_MEMBERS = ['caller', 'readOnly', 'tools', 'workflows'];

/** The refusal of a `limits` option the server does not understand: thrown when it is built. */
export function invalidLimitsOption(problem: string): string {
  return `createRealmMcpServer: the limits option ${problem}. Refused when the server is built: a limit that is not understood could limit nothing. Fix the option.`;
}

/** A non-empty list of non-empty strings, or the problem with it. */
function listProblem(value: unknown, member: string): string | undefined {
  if (!Array.isArray(value)) return `has a ${member} member that is not a list`;
  if (value.length === 0) return `has an empty ${member} list`;
  if (value.some((item) => typeof item !== 'string' || item === '')) {
    return `has a ${member} item that is not a non-empty string`;
  }
  return undefined;
}

/**
 * Checks a `limits` option when the server is built (a closed shape, as the principal is): throws
 * {@link invalidLimitsOption} naming the first problem. A tool name must be one of Realm's tools,
 * whatever this server registers.
 */
export function assertLimitsOption(value: unknown): void {
  const refuse = (problem: string): never => {
    throw new Error(invalidLimitsOption(problem));
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse('is not an object');
  }
  const limits = value as Record<string, unknown>;
  const unknownMember = Object.keys(limits).find((key) => !LIMITS_MEMBERS.includes(key));
  if (unknownMember !== undefined) {
    refuse(
      `has an unknown member ${JSON.stringify(unknownMember)} (its members are caller, readOnly, tools and workflows)`,
    );
  }
  if (typeof limits['caller'] !== 'string' || limits['caller'] === '') {
    refuse('has no caller: caller must be a non-empty string');
  }
  const { readOnly, tools, workflows } = limits;
  if (readOnly === undefined && tools === undefined && workflows === undefined) {
    refuse('names no limit: give readOnly, tools or workflows');
  }
  if (readOnly !== undefined && readOnly !== true) refuse('has a readOnly that is not true');
  if (readOnly !== undefined && tools !== undefined) refuse('has both readOnly and tools');
  if (tools !== undefined) {
    const problem = listProblem(tools, 'tools');
    if (problem !== undefined) refuse(problem);
    const unknownTool = (tools as string[]).find((name) => !Object.hasOwn(TOOL_ANNOTATIONS, name));
    if (unknownTool !== undefined) {
      refuse(
        `names the tool ${JSON.stringify(unknownTool)}, which is not a Realm tool (its tools: ${Object.keys(TOOL_ANNOTATIONS).join(', ')})`,
      );
    }
  }
  if (workflows !== undefined) {
    const problem = listProblem(workflows, 'workflows');
    if (problem !== undefined) refuse(problem);
  }
}

/** Whether `limits` lets its caller call `tool` (the tool rule alone; `create_workflow` also needs no
 *  workflow list). */
export function mayCall(limits: CallerLimits | undefined, tool: ToolName): boolean {
  if (limits === undefined) return true;
  if (limits.readOnly === true && !READING_TOOLS.includes(tool)) return false;
  if (limits.tools !== undefined && !limits.tools.includes(tool)) return false;
  return tool !== 'create_workflow' || limits.workflows === undefined;
}

/** What a call names, by tool: its workflow, its run, or a workflow it would create. */
interface Named {
  readonly workflow?: unknown;
  readonly run?: unknown;
  readonly creates?: true;
}

const RUN_TOOL = (args: Record<string, unknown>): Named[] => [{ run: args['run_id'] }];

/** Per tool, in the order they are checked (a batch: its workflow, then its parent run). */
const NAMED_BY: Record<ToolName, (args: Record<string, unknown>) => Named[]> = {
  list_workflows: () => [], // its list is filtered to the caller's workflows instead
  get_workflow_protocol: (args) => [{ workflow: args['workflow_id'] }],
  start_run: (args) => [{ workflow: args['workflow_id'] }],
  start_run_batch: (args) => [
    { workflow: args['workflow_id'] },
    ...(args['parent_run_id'] !== undefined ? [{ run: args['parent_run_id'] }] : []),
  ],
  execute_step: RUN_TOOL,
  advance_run: RUN_TOOL,
  submit_human_response: RUN_TOOL,
  present_question: RUN_TOOL,
  get_run_state: RUN_TOOL,
  abandon_run: RUN_TOOL,
  append_trace: RUN_TOOL,
  create_workflow: () => [{ creates: true }],
};

const ASK = "Ask the server's operator for a key that allows it.";

/** Whether the run's record names one of `workflows`: a missing run, and one that cannot be read, do
 *  not; a read error other than a missing run is logged, masked. */
async function runWithin(
  runId: string,
  workflows: readonly string[],
  limits: CallerLimits,
  runStore: RunStore | undefined,
): Promise<boolean> {
  try {
    if (runStore === undefined) throw new Error('no run store was given');
    const { record } = await runStore.get(runId);
    return workflows.includes(record.workflow_id);
  } catch (err) {
    if (!(err instanceof WorkflowError && err.code === 'STATE_RUN_NOT_FOUND')) {
      logMasked(
        `realm-mcp: a run could not be read to check key '${limits.caller}': ${String(err)}`,
      );
    }
    return false;
  }
}

/** The sentence refusing `tool` for `limits`, or undefined when the call is inside them. */
async function outsideLimits(
  tool: ToolName,
  limits: CallerLimits,
  args: Record<string, unknown>,
  runStore: RunStore | undefined,
): Promise<string | undefined> {
  const key = `Key '${limits.caller}'`;
  if (limits.readOnly === true && !READING_TOOLS.includes(tool)) {
    return `${key} may not call ${tool}: it may call only the reading tools (${READING_TOOLS.join(', ')}). ${ASK}`;
  }
  if (limits.tools !== undefined && !limits.tools.includes(tool)) {
    return `${key} may not call ${tool}: it may call only ${limits.tools.join(', ')}. ${ASK}`;
  }
  const workflows = limits.workflows;
  if (workflows === undefined) return undefined;
  const ids = workflows.join(', ');
  for (const named of NAMED_BY[tool](args)) {
    if (named.creates === true) {
      return `${key} may not create workflows: it may reach only the workflows ${ids}. ${ASK}`;
    }
    if (named.workflow !== undefined && !workflows.includes(named.workflow as string)) {
      return `${key} may not use workflow '${capText(String(named.workflow))}': it may reach only the workflows ${ids}. ${ASK}`;
    }
    if (
      named.run !== undefined &&
      !(await runWithin(String(named.run), workflows, limits, runStore))
    ) {
      return `${key} may not reach run '${capText(String(named.run))}': it may reach only the runs of the workflows ${ids}. ${ASK}`;
    }
  }
  return undefined;
}

/**
 * The one check every tool calls first: `handler` itself when the server has no limits; else a
 * handler that refuses a call outside them — before the tool reads or writes anything but the named
 * run's record — and otherwise calls `handler`. The refusal is Realm's ordinary error reply
 * (`CALL_OUTSIDE_LIMITS`, the sentence as `errors[0]` and `context_hint`), rendered with the door's
 * set for no subject; `floor` gives it the twin a tool with an output schema sends. A check that
 * fails sends the fixed text, never the call.
 */
export function withinLimits<A extends unknown[]>(
  tool: ToolName,
  opts: LimitStores,
  handler: (...args: A) => Promise<ToolResult>,
  floor?: TwinFloor,
): (...args: A) => Promise<ToolResult> {
  const limits = opts.limits;
  if (limits === undefined) return handler;
  return safeTool(
    async (...args: A) => {
      const named = (args[0] ?? {}) as Record<string, unknown>;
      const sentence = await outsideLimits(tool, limits, named, opts.runStore);
      if (sentence === undefined) return handler(...args);
      const err = new WorkflowError(sentence, {
        code: 'CALL_OUTSIDE_LIMITS',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
      const runId = typeof named['run_id'] === 'string' ? named['run_id'] : '';
      const rendered = renderReply(
        buildPreExecutionErrorEnvelope(tool, runId, 0, err, sentence),
        mcpHostOf(opts),
      );
      // As every tool's refusal that read no run: no `run_version`.
      const { run_version: _version, ...envelope } = rendered.envelope;
      const disclosure = {
        set: await disclosureOfTool(opts).setFor(undefined),
        audience: 'agent' as const,
        table: MCP_ENVELOPE_TABLE,
      };
      return floor !== undefined
        ? toolContentWithTwinOf(envelope, disclosure, undefined, floor)
        : toolContentOf(envelope, disclosure);
    },
    (err: unknown, ..._args: A): never => {
      throw err;
    },
    SAFE_TOOL_CONSTANT_RUNLESS,
  );
}

/** A tool's `safeTool` handler with the caller's limits checked first ({@link withinLimits}). */
export function limitedTool<A extends unknown[]>(
  tool: ToolName,
  opts: LimitStores,
  body: (...args: A) => Promise<ToolResult>,
  onError: (err: unknown, ...args: A) => Promise<ToolResult> | ToolResult,
  constant?: string,
  floor?: TwinFloor,
): (...args: A) => Promise<ToolResult> {
  return withinLimits(tool, opts, safeTool(body, onError, constant), floor);
}
