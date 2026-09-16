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

/**
 * issue #558 PR-T — the cap on what `run list --stuck` will PARSE while classifying a run's
 * workflow copy. Measured (design §2.4): the largest real registry entry on the owner's store is
 * 65 KB; the smallest #557 expansion bomb is 136 MB. A listing must never be the surface that
 * detonates one, so above this size the finding NAMES the size and reads zero bytes — the
 * operator is pointed at `validate --registered`, which is the surface that parses.
 *
 * This cap does NOT apply to `get()`: the run path stays uncapped by #552's Resolution.
 */
export const STUCK_DEFINITION_PARSE_CAP_BYTES = 4 * 1024 * 1024;

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
    // `statSync` SUCCEEDS on a `chmod 000` file — stat needs only search permission on the
    // parent directory. Without this call the ONE class this PR is named for (permission)
    // escapes `readFileSync` as a raw non-`WorkflowError` and passes `getWorkflowForRun` by
    // identity: a bare `EACCES: permission denied`, no code, no remedy (executed).
    try {
      accessSync(filePath, constants.R_OK);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      return {
        ok: false,
        class: 'unreadable',
        ...(errno !== undefined ? { errno } : {}),
        path: filePath,
      };
    }
    return { ok: true, bytes: st.size };
  }

  async get(workflowId: string): Promise<WorkflowDefinition> {
    return this.getSync(workflowId);
  }

  /**
   * issue #558 PR-T — `get()`'s body, synchronously. `get()` awaits nothing; the `--stuck` probe
   * closure classifies inside a synchronous filter and must reuse this EXACT policy (parse →
   * root → legacy) so a corrupt, null-root or legacy copy speaks with one voice on every surface
   * rather than through a second, drifting re-derivation.
   */
  getSync(workflowId: string): WorkflowDefinition {
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
    unreadable: Array<{
      file: string;
      class: ProbeFailureClass | 'parse';
      /** issue #558 PR-T — present only for the OS-error classes; `workflow list`'s per-class
       *  sentence names it. Absent for `parse`, `empty` and `not_a_file` (a directory is not an
       *  OS error — fabricating an errno is a false statement about the operating system). */
      errno?: string;
      reason: string;
    }>;
    mismatched: Array<{ file: string; id: string }>;
  }> {
    const workflows: WorkflowDefinition[] = [];
    const unreadable: Array<{
      file: string;
      class: ProbeFailureClass | 'parse';
      errno?: string;
      reason: string;
    }> = [];
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
            ...(errno !== undefined ? { errno } : {}),
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
          ...(probed.errno !== undefined ? { errno: probed.errno } : {}),
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

    const path = String((err.details as Record<string, unknown> | undefined)?.['path'] ?? '');

    /**
     * The repair clause, minted ONCE per code (a second hand-typed copy is the #444/#508 class).
     * `withRetry: false` is the terminal branch: nothing to retry, but the COPY is still broken
     * for every other run of that workflow, so the repair is still worth naming.
     */
    // A terminal run's leftover pending_gate (the #282 zombie class) is not answerable — only a
    // LIVE run's gate shapes the text below.
    const gate = run.terminal_state === true ? undefined : run.pending_gate;
    const answer =
      gate === undefined
        ? undefined
        : `realm run respond ${run.id} --gate ${gate.gate_id} --choice <one of: ${gate.choices.join(', ')}>`;
    // The repair's closing act: the retry verb for a gate-less run; for a gate-waiting run the
    // gate itself, since that is what the operator was trying to do (review fold C12).
    const then = answer === undefined ? opts.retryVerb : `answer the gate (${answer})`;
    const repairClause = (withRetry: boolean): string | undefined => {
      if (err.code === 'STATE_WORKFLOW_UNREADABLE')
        return `To repair: fix ${path}${withRetry ? ` and ${then}` : ''}.`;
      if (err.code === 'RESOURCE_FORMAT_INVALID')
        // Re-register is the ONE repair. "or remove the corrupt copy" was offered here and repairs
        // nothing — after `rm` the next attempt says "Workflow not found" and asks for the register
        // the operator may have no source for (executed; the fresh walk's T5). Review fold C11.
        return (
          `To repair: re-register the workflow from its source ` +
          `(realm workflow register <path-to-workflow>)${withRetry ? `, then ${then}` : ''}.`
        );
      // `missing` self-remedies (the #456 hedge / the agent-created sentence) and `legacy`
      // carries its own "Re-register it with: …" — neither gets a second repair clause.
      return undefined;
    };

    // The terminal conjunct: the six sites without `terminalOk` read the definition BEFORE their
    // own terminal check, so "retry" on a terminal run is a falsity. `terminalOk: true` is passed
    // at the SEVEN sites whose happy path IS terminal (replay, drain ×5, resume — `resume.ts:84`
    // refuses any phase outside RESUMABLE_PHASES = {failed, abandoned}, both terminal, BEFORE the
    // definition is read at `:97`).
    if (run.terminal_state === true && opts.terminalOk !== true) {
      const repair = repairClause(false);
      throw copy(
        `${err.message}. The run is terminal (${deriveRunPhase(run)}); there is nothing to ` +
          `${opts.verb}.${repair !== undefined ? ` ${repair}` : ''}`,
      );
    }

    /**
     * The disposal clause — the LEAD-IN forks with it. "To end the run: this run is waiting on
     * human gate 'x'" promises a way OUT and then describes a STATE; the gate fork carries its
     * own sentence instead. PR-V replaces the gate fork's tail with the void (MASTER-PLAN rule
     * 15); `realm run abandon` has exactly one option today, so nothing else is printable.
     */
    // Review fold C12 — the gate fork. The earlier text offered "answer it (realm run respond …)"
    // as the way out: the exact command that had just failed on this unreadable copy, and it named
    // "#558 PR-V" to an operator, which reads as a flag to search for (the fresh walk's T11/T12).
    // Now the clause states the two facts — the gate cannot be answered until the copy reads, and
    // `realm run abandon` refuses a gate-waiting run (abandon-run.ts) — and the REPAIR clause ends
    // in the answer command. PR-V's void replaces this sentence (its sweep list carries it).
    const disposalSentence = (leadIn: string): string =>
      gate === undefined
        ? `${leadIn} realm run abandon ${run.id}.`
        : `This run is waiting on human gate '${gate.step_name}', which cannot be answered until ` +
          `its workflow can be read; realm run abandon refuses a run that is waiting on a gate.`;

    // Reached with `terminal_state` only through `terminalOk` (the sites whose happy path IS a
    // terminal run — drain, replay, resume, inspect): there is nothing left to END, so the
    // disposal clause is omitted — `realm run abandon` refuses a finished run (executed on the
    // pre-fold build: drain and replay both printed "To end the run: realm run abandon <id>"
    // for a failed run, and abandon then said "cannot abandon a finished run"). Review fold C9.
    const terminal = run.terminal_state === true;
    const join = (...parts: Array<string | undefined>): string =>
      parts.filter((p): p is string => p !== undefined && p !== '').join(' ');

    switch (err.code) {
      case 'STATE_WORKFLOW_NOT_FOUND':
        // A SHAPE heuristic, not provenance: `deriveWorkflowId` mints `dynamic-<16hex>` and
        // `<slug>-<16hex>`, so a human-registered id that happens to carry a 16-hex suffix gets
        // the agent sentence too. Keyed on the id, never on a record field realm does not have.
        throw /-[0-9a-f]{16}$/.test(run.workflow_id)
          ? copy(
              `Workflow '${run.workflow_id}' not found — this run's workflow was created by an ` +
                `agent (create_workflow) and its stored copy is gone; there is no source file ` +
                `to register.${terminal ? '' : ` ${disposalSentence('To end the run:')}`}`,
            )
          : copy(
              // The #456 arm, pinned whole-message by `run-attach.test.ts` C12 and 28 substring
              // pins: its em-dash join ships VERBATIM. The "joins are sentences" rule governs
              // the clauses this composer ADDS, not the arms quoted from main.
              `${err.message} — most often this run was created from a file without --register. ` +
                `Register the workflow (realm workflow register <file>) and ${opts.retryVerb}.`,
            );
      case 'STATE_WORKFLOW_UNREADABLE':
        throw copy(
          join(
            `${err.message}.`,
            terminal
              ? undefined
              : gate === undefined
                ? `This run's workflow cannot be read. ${disposalSentence('To end the run:')}`
                : disposalSentence(''),
            repairClause(true),
          ),
        );
      case 'RESOURCE_FORMAT_INVALID':
        throw copy(
          join(
            `${err.message}.`,
            terminal ? undefined : disposalSentence('To end the run:'),
            repairClause(true),
          ),
        );
      case 'STATE_LEGACY_FORMAT':
        // The store's own message already carries the re-register remedy (wrapping it again would
        // double-remedy — this function's JSDoc); a gate-waiting run is told what comes after it.
        throw copy(
          join(
            `${err.message}.`,
            terminal ? undefined : disposalSentence('To end the run instead:'),
            terminal || answer === undefined
              ? undefined
              : `Once re-registered, answer the gate (${answer}).`,
          ),
        );
      default:
        throw err;
    }
  }
}
