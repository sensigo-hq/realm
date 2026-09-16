// JsonWorkflowStore — persists registered WorkflowDefinition objects to ~/.realm/workflows/.
import { readFileSync, mkdirSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import { WorkflowError } from '../types/workflow-error.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';
import { deriveRunPhase } from '../engine/eligibility.js';
import { atomicWriteFile } from '../store/atomic-write.js';

/** issue #558 PR-T — what a registry read can fail as, before any bytes are parsed. */
export type ProbeFailureClass =
  'missing' | 'unreadable' | 'not_a_file' | 'empty' | 'registry_broken';

export type ProbeResult =
  | { ok: true; bytes: number }
  | { ok: false; class: ProbeFailureClass; errno?: string; path: string };

/**
 * issue #558 PR-T — ONE table from a probe class to the error an operator sees. EXHAUSTIVE over
 * `ProbeFailureClass` with NO `default`: a sixth class fails `tsc` (TS2366) rather than falling
 * through to a generic sentence.
 */
export function probeClassToError(
  result: Extract<ProbeResult, { ok: false }>,
  workflowId: string,
): WorkflowError {
  switch (result.class) {
    case 'missing':
      return new WorkflowError(`Workflow not found: ${workflowId}`, {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    case 'unreadable':
      return new WorkflowError(
        `the registered copy of '${workflowId}' could not be read (${result.errno ?? 'unknown'}: ${result.path})`,
        {
          code: 'STATE_WORKFLOW_UNREADABLE',
          category: 'STATE',
          agentAction: 'stop',
          retryable: false,
          details: { class: result.class, errno: result.errno, path: result.path },
        },
      );
    case 'not_a_file':
      return new WorkflowError(`${result.path} is a directory, not a workflow file`, {
        code: 'STATE_WORKFLOW_UNREADABLE',
        category: 'STATE',
        agentAction: 'stop',
        retryable: false,
        // NO `errno` key — a directory is not an OS error, and fabricating one is a false
        // statement about the operating system.
        details: { class: result.class, path: result.path },
      });
    case 'empty':
      return new WorkflowError(
        `the registered copy of '${workflowId}' is empty (0 bytes) — not a workflow`,
        {
          code: 'RESOURCE_FORMAT_INVALID',
          category: 'RESOURCE',
          agentAction: 'stop',
          retryable: false,
          details: { class: result.class, path: result.path },
        },
      );
    case 'registry_broken':
      return new WorkflowError(
        `the workflow registry at ${result.path} cannot be read (${result.errno ?? 'unknown'})`,
        {
          code: 'STATE_WORKFLOW_UNREADABLE',
          category: 'STATE',
          agentAction: 'stop',
          retryable: false,
          details: { class: result.class, errno: result.errno, path: result.path },
        },
      );
  }
}

/**
 * issue #558 PR-T — ONE builder for the parse class, so a corrupt copy speaks with one voice on
 * `get()`, on `listWithDiagnostics`, and in the `--stuck` probe closure.
 */
export function parseFailureError(workflowId: string, path: string, cause: unknown): WorkflowError {
  const opts = {
    code: 'RESOURCE_FORMAT_INVALID' as const,
    category: 'RESOURCE' as const,
    agentAction: 'stop' as const,
    retryable: false,
    details: { path },
  };
  if (cause instanceof Error) {
    return new WorkflowError(
      `the registered copy of '${workflowId}' is not parseable JSON: ${cause.message}`,
      opts,
    );
  }
  const shape = cause === null ? 'null' : Array.isArray(cause) ? 'array' : typeof cause;
  return new WorkflowError(
    `the registered copy of '${workflowId}' is JSON but not a workflow object (it is ${shape})`,
    opts,
  );
}

export interface WorkflowRegistrar {
  /** Persist a WorkflowDefinition under its id, overwriting any previous registration. */
  register(definition: WorkflowDefinition): Promise<void>;
  /** Retrieve a WorkflowDefinition by id. Throws WorkflowError if not found. */
  get(workflowId: string): Promise<WorkflowDefinition>;
  /** List all registered workflows. */
  list(): Promise<WorkflowDefinition[]>;
}

/**
 * Stores WorkflowDefinition objects as JSON files at ~/.realm/workflows/{id}.json.
 */
export class JsonWorkflowStore implements WorkflowRegistrar {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? join(homedir(), '.realm', 'workflows');
    mkdirSync(this.dir, { recursive: true });
  }

  async register(definition: WorkflowDefinition): Promise<void> {
    await atomicWriteFile(
      join(this.dir, `${definition.id}.json`),
      JSON.stringify(definition, null, 2),
    );
  }

  /**
   * issue #558 PR-T — classify a registry read BEFORE any bytes are read. CONCRETE (off the
   * `WorkflowRegistrar` interface, the `listWithDiagnostics` precedent): no other implementation
   * has to grow a method for a legibility surface only realm's own fs store can answer.
   *
   * The registry directory is checked FIRST, and its `ENOENT` is carved out to `missing`: a fresh
   * HOME has no registry, and telling a first-time user their registry is unreadable is a lie.
   */
  probe(workflowId: string): ProbeResult {
    const filePath = join(this.dir, `${workflowId}.json`);
    try {
      accessSync(this.dir, constants.R_OK | constants.X_OK);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') return { ok: false, class: 'missing', path: filePath };
      return {
        ok: false,
        class: 'registry_broken',
        ...(errno !== undefined ? { errno } : {}),
        path: this.dir,
      };
    }
    let st;
    try {
      st = statSync(filePath);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') return { ok: false, class: 'missing', path: filePath };
      return {
        ok: false,
        class: 'unreadable',
        ...(errno !== undefined ? { errno } : {}),
        path: filePath,
      };
    }
    if (!st.isFile()) return { ok: false, class: 'not_a_file', path: filePath };
    if (st.size === 0) return { ok: false, class: 'empty', path: filePath };
    return { ok: true, bytes: st.size };
  }

  async get(workflowId: string): Promise<WorkflowDefinition> {
    const filePath = join(this.dir, `${workflowId}.json`);
    const probed = this.probe(workflowId);
    if (!probed.ok) throw probeClassToError(probed, workflowId);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      // TOCTOU only: `probe()` just said this file is readable. Classified through the same
      // table so the sentence never regresses to the #456 hedge.
      const errno = (err as NodeJS.ErrnoException).code;
      throw probeClassToError(
        {
          ok: false,
          class: 'unreadable',
          ...(errno !== undefined ? { errno } : {}),
          path: filePath,
        },
        workflowId,
      );
    }
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(raw);
    } catch (err) {
      throw parseFailureError(workflowId, filePath, err);
    }
    if (
      parsedUnknown === null ||
      typeof parsedUnknown !== 'object' ||
      Array.isArray(parsedUnknown)
    ) {
      throw parseFailureError(workflowId, filePath, parsedUnknown);
    }
    const parsed = parsedUnknown as WorkflowDefinition;
    if (
      parsed.schema_version === undefined ||
      parsed.schema_version < CURRENT_WORKFLOW_SCHEMA_VERSION
    ) {
      throw new WorkflowError(
        'This workflow was registered with an older version of Realm. ' +
          'Re-register it with: realm workflow register <path-to-workflow>',
        {
          code: 'STATE_LEGACY_FORMAT',
          category: 'STATE',
          agentAction: 'report_to_user',
          retryable: false,
        },
      );
    }
    return parsed;
  }

  async list(): Promise<WorkflowDefinition[]> {
    // Re-expressed over listWithDiagnostics (issue #427) so there is ONE directory walk and one
    // parse policy. The interface contract is unchanged — callers that only want the readable
    // definitions still get exactly those, and the skipped files stay skipped here.
    const { workflows } = await this.listWithDiagnostics();
    return workflows;
  }

  /**
   * Everything `list()` returns, plus what it silently drops (issue #427).
   *
   * `list()` skips a file it cannot parse, which is right for a caller that just wants the
   * definitions and wrong for an operator asking what is in their registry: realm cannot audit
   * what it cannot read, and saying nothing about it is how a broken entry stays invisible.
   *
   * `mismatched` covers a second invisible case. `<id>.json` is the write convention, but a
   * hand-edited file can carry an inner id that differs from its basename — and since anything
   * resolving a workflow by id resolves by FILENAME, such an entry is reachable under a name
   * this list would not print. Disclosed rather than corrected.
   *
   * Additive and CONCRETE: `WorkflowRegistrar` is untouched, so no other implementation has to
   * grow a method to satisfy a read surface only the CLI uses.
   */
  async listWithDiagnostics(): Promise<{
    workflows: WorkflowDefinition[];
    unreadable: Array<{ file: string; class: ProbeFailureClass | 'parse'; reason: string }>;
    mismatched: Array<{ file: string; id: string }>;
  }> {
    const workflows: WorkflowDefinition[] = [];
    const unreadable: Array<{ file: string; class: ProbeFailureClass | 'parse'; reason: string }> =
      [];
    const mismatched: Array<{ file: string; id: string }> = [];
    // issue #558 PR-T: an unreadable registry DIRECTORY is a diagnostic, never a throw out of
    // this method (main crashed `workflow list` with a stack trace at readdirSync).
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      const failure = {
        ok: false as const,
        class: 'registry_broken' as const,
        ...(errno !== undefined ? { errno } : {}),
        path: this.dir,
      };
      return {
        workflows: [],
        unreadable: [
          {
            file: this.dir,
            class: 'registry_broken',
            reason: probeClassToError(failure, this.dir).message,
          },
        ],
        mismatched: [],
      };
    }
    for (const entry of entries) {
      const id = entry.slice(0, -'.json'.length);
      // issue #558 PR-T: a `{ok:false}` entry is NEVER read — its class IS the diagnostic.
      const probed = this.probe(id);
      if (!probed.ok) {
        unreadable.push({
          file: entry,
          class: probed.class,
          reason: probeClassToError(probed, id).message,
        });
        continue;
      }
      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(readFileSync(join(this.dir, entry), 'utf8'));
      } catch (err) {
        unreadable.push({
          file: entry,
          class: 'parse',
          reason: parseFailureError(id, join(this.dir, entry), err).message,
        });
        continue;
      }
      if (
        parsedUnknown === null ||
        typeof parsedUnknown !== 'object' ||
        Array.isArray(parsedUnknown)
      ) {
        unreadable.push({
          file: entry,
          class: 'parse',
          reason: parseFailureError(id, join(this.dir, entry), parsedUnknown).message,
        });
        continue;
      }
      const parsed = parsedUnknown as WorkflowDefinition;
      workflows.push(parsed);
      if (entry !== `${String(parsed.id)}.json`) {
        mismatched.push({ file: entry, id: String(parsed.id) });
      }
    }
    return { workflows, unreadable, mismatched };
  }
}

/**
 * Fetches the workflow definition a run-context resolution needs, wrapping a
 * `STATE_WORKFLOW_NOT_FOUND` throw with the one-time-register remedy (issue #456) — the ONE
 * chokepoint every run-context site (`respond`, `resume`, `replay`, `drain`, `agent --run-id`,
 * and the MCP `submit_human_response`/`execute_step`/`append_trace` tools) calls, instead of each
 * hand-wrapping its own raw `store.get(run.workflow_id)`.
 *
 * The `store` and `run` parameters are narrowed to exactly what this function uses
 * (`Pick<WorkflowRegistrar, 'get'>` / `Pick<RunRecord, 'workflow_id'>`) — by necessity, not taste:
 * `resolveRunAttach`'s own dependency type IS that narrower `Pick` (its test doubles are get-only,
 * and a full `WorkflowRegistrar` parameter here would not compile at that call site). Every other
 * caller passes a full registrar and a full run record, both structurally assignable to the
 * narrower type.
 *
 * HEDGED reasoning, moved here from `run-attach.ts`'s inline comment (its call site now just
 * points back here): this function genuinely cannot know WHY the workflow is missing. A wiped
 * store, a different `$HOME`, and a run created from a file without `--register` all mint the
 * identical `STATE_WORKFLOW_NOT_FOUND` from the registrar — so the remedy says "most often",
 * never "because". Keyed on the stable error CODE, never on message text.
 *
 * PRECONDITION — run-context resolution ONLY. A by-id lookup with no run behind it (`start_run`,
 * `start_run_batch`, `get_workflow_protocol`) must never call this: there the hedge would be
 * false — "this run was created from a file without --register" presumes a run that does not
 * exist yet.
 *
 * Every OTHER `WorkflowError` (e.g. `STATE_LEGACY_FORMAT`, which already carries its own correct
 * "Re-register it with: …" remedy) passes through completely untouched, by identity — wrapping it
 * would double-remedy. A non-`WorkflowError` throw also passes through untouched.
 *
 * issue #493 seam: if definition snapshots ever land on the run record, the snapshot-wins
 * resolution order belongs INSIDE this function — every run-context caller updates for free.
 *
 * @param store Anything that can `.get()` a workflow by id.
 * @param run   The run whose `workflow_id` to resolve.
 * @param opts  `retryVerb` — the verb this call site's remedy should recommend retrying with
 *              (e.g. `'re-attach'`, `'respond again'`, `'resume again'`, `'replay again'`,
 *              `'drain again'`, or the MCP-neutral `'retry'`).
 */
export async function getWorkflowForRun(
  store: Pick<WorkflowRegistrar, 'get'>,
  run: RunRecord,
  opts: { retryVerb: string; verb: string; terminalOk?: boolean },
): Promise<WorkflowDefinition> {
  try {
    return await store.get(run.workflow_id);
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    const copy = (message: string): WorkflowError =>
      new WorkflowError(message, {
        code: err.code,
        category: err.category,
        agentAction: err.agentAction,
        retryable: err.retryable,
        details: err.details,
        ...(err.warnings !== undefined ? { warnings: err.warnings } : {}),
      });

    // The terminal conjunct: these sites read the definition BEFORE their own terminal check, so
    // "retry" on a terminal run is a falsity. `terminalOk` is passed at the six sites whose happy
    // path IS terminal (replay, drain ×5).
    if (run.terminal_state === true && opts.terminalOk !== true) {
      throw copy(
        `${err.message} — the run is terminal (${deriveRunPhase(run)}); there is nothing to ${opts.verb}.`,
      );
    }

    const disposal =
      run.pending_gate === undefined
        ? `realm run abandon ${run.id}`
        : `this run is waiting on human gate '${run.pending_gate.step_name}' — answer it ` +
          `(realm run respond ${run.id} --gate ${run.pending_gate.gate_id} --choice <one of: ` +
          `${run.pending_gate.choices.join(', ')}>); ending a gate-waiting run is #558 PR-V`;

    switch (err.code) {
      case 'STATE_WORKFLOW_NOT_FOUND':
        // A SHAPE heuristic, not provenance: `deriveWorkflowId` mints `dynamic-<16hex>` and
        // `<slug>-<16hex>`, so a human-registered id that happens to carry a 16-hex suffix gets
        // the agent sentence too. Keyed on the id, never on a record field realm does not have.
        return Promise.reject(
          /-[0-9a-f]{16}$/.test(run.workflow_id)
            ? copy(
                `Workflow '${run.workflow_id}' not found — this run's workflow was created by an ` +
                  `agent (create_workflow) and its stored copy is gone; there is no source file ` +
                  `to register. To end the run: ${disposal}.`,
              )
            : copy(
                `${err.message} — most often this run was created from a file without --register. ` +
                  `Register the workflow (realm workflow register <file>) and ${opts.retryVerb}.`,
              ),
        );
      case 'STATE_WORKFLOW_UNREADABLE':
        throw copy(
          `${err.message} — this run's workflow cannot be read. To end the run: ${disposal}. ` +
            `To repair: fix ${String((err.details as Record<string, unknown> | undefined)?.['path'] ?? '')} and ${opts.retryVerb}.`,
        );
      case 'RESOURCE_FORMAT_INVALID':
        throw copy(
          `${err.message}. To end the run: ${disposal}. To repair: re-register the workflow from ` +
            `its source (realm workflow register <path-to-workflow>) or remove the corrupt copy ` +
            `at ${String((err.details as Record<string, unknown> | undefined)?.['path'] ?? '')}, then ${opts.retryVerb}.`,
        );
      case 'STATE_LEGACY_FORMAT':
        throw copy(`${err.message} To end the run instead: ${disposal}.`);
      default:
        throw err;
    }
  }
}
