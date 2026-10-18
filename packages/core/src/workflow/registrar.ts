// JsonWorkflowStore — persists registered WorkflowDefinition objects to ~/.realm/workflows/.
import { readFileSync, mkdirSync, readdirSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import {
  WorkflowError,
  newerDefinitionFactsOf,
  storedFileFactsOf,
  type WorkflowErrorOptions,
} from '../types/workflow-error.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from './yaml-loader.js';
import { deriveRunPhase } from '../engine/eligibility.js';
import { withFullStop } from '../engine/pending.js';
import {
  renderDefinitionAbsent,
  type DefinitionAbsence,
  type RegisterWay,
  type WayOn,
} from '../engine/ways.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { brandClass, REALM_BRAND } from '../brand.js';
import { admitEntry } from '../admission.js';
import {
  jsonShapeOf,
  type WorkflowCopyFault,
  renderUnreadableStoredFile,
  type UnreadableFileFacts,
} from '../store/run-file.js';

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
      // issue #719 (R7, C3): the damaged-file facts, and the one composer's words.
      return workflowCopyError({ resource: 'workflow_copy', class: 'empty', path: result.path });
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

/** issue #719 (C3): a registered copy whose bytes are wrong (`empty`, `parse`) — its facts, and
 *  the one composer's words, built from those facts alone. */
function workflowCopyError(facts: UnreadableFileFacts): WorkflowError {
  return new WorkflowError(renderUnreadableStoredFile(facts), {
    code: 'RESOURCE_FORMAT_INVALID',
    category: 'RESOURCE',
    agentAction: 'stop',
    retryable: false,
    // #729 PR-0 (Amendments 7, 7e): the facts are typed, keyed on `scope`.
    facts: { scope: 'file', ...facts },
  });
}

/** A read failure's stored-file facts (#729 PR-0: typed `facts`), or `undefined` for the registry's
 *  own probe failures, whose class, path and errno stay in `details` (Amendment 11). */
function storedFileFacts(err: WorkflowError): UnreadableFileFacts | undefined {
  // issue #759: a thin alias of core's one narrowing (`storedFileFactsOf`), to one file's facts.
  const stored = storedFileFactsOf(err);
  return stored?.scope === 'file' ? stored : undefined;
}

/** issue #719 (C3): what is wrong with a registered copy's bytes — they are not JSON, or they are
 *  JSON that is not an object (`shape`: `null`, `array`, `string`, `number` or `boolean`), or
 *  (#627 W correction 2, 3.7 and 8.6 (d)) an object that is not a workflow (`fault`). */
export type WorkflowCopyParseFault =
  | { kind: 'not_json' }
  | { kind: 'not_object'; shape: string }
  | { kind: 'not_a_workflow'; fault: WorkflowCopyFault };

/**
 * issue #558 PR-T — ONE builder for the parse class, so a corrupt copy speaks with one voice on
 * `get()`, on `listWithDiagnostics`, and in the `--stuck` probe closure.
 *
 * issue #719 (R7, R8, C3): it takes the fault, stated — never a parsed root and never the parser's
 * error (its message quotes the file around the fault). The copy is named by its file (`path`);
 * its details are the damaged-file facts, and its words the one composer's.
 */
export function parseFailureError(path: string, fault: WorkflowCopyParseFault): WorkflowError {
  return workflowCopyError({
    resource: 'workflow_copy',
    class: 'parse',
    path,
    ...(fault.kind === 'not_object' ? { shape: fault.shape } : {}),
    ...(fault.kind === 'not_a_workflow' ? { fault: fault.fault } : {}),
  });
}

/**
 * The parse fault of a value that parsed — the ONE check `getSync` and the listing both run, so a
 * copy is damaged at both or at neither (#627 W correction 2, 3.7 and 8.6 (d)): not an object; a
 * `schema_version` that is present, not `null` and not a number; no string `id`. #819 (U3): a copy
 * with no `schema_version` (or `null`) is the older cohort's only in its shape — a string `name`
 * and a number `version`, as all 14 real ones are (W-C2R-CORE-12) — else `not_legacy_shape`. (U2):
 * a copy at the current format whose `steps` is not an object — `no_steps`. `undefined` for an
 * object that can be read as a workflow — legacy, current or newer: a NEWER copy is judged by
 * {@link isNewerDefinition} after this, so one without `steps` reads newer. The older cohort carries
 * no `steps` key at all, so `steps` is judged only at the current format.
 */
function copyFault(value: unknown): WorkflowCopyParseFault | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'not_object', shape: jsonShapeOf(value) };
  }
  const copy = value as Record<string, unknown>;
  const version = copy['schema_version'];
  if (version !== undefined && version !== null && typeof version !== 'number') {
    return { kind: 'not_a_workflow', fault: 'schema_version_not_number' };
  }
  if (typeof copy['id'] !== 'string') return { kind: 'not_a_workflow', fault: 'no_id' };
  if (
    (version === undefined || version === null) &&
    !(typeof copy['name'] === 'string' && typeof copy['version'] === 'number')
  ) {
    return { kind: 'not_a_workflow', fault: 'not_legacy_shape' };
  }
  const steps = copy['steps'];
  if (
    version === CURRENT_WORKFLOW_SCHEMA_VERSION &&
    (steps === null || typeof steps !== 'object' || Array.isArray(steps))
  ) {
    return { kind: 'not_a_workflow', fault: 'no_steps' };
  }
  return undefined;
}

/** #627 W correction 2 (3.7): the ONE reading of "a later Realm registered this copy" — a number above
 *  the format this version reads. Both `getSync` and the listing ask it. */
export function isNewerDefinition(copy: { schema_version?: unknown }): boolean {
  return (
    typeof copy.schema_version === 'number' && copy.schema_version > CURRENT_WORKFLOW_SCHEMA_VERSION
  );
}

/** A legacy copy (no `schema_version`, `null`, or a number below current) — an older version of Realm
 *  registered it. */
function isLegacyDefinition(copy: { schema_version?: unknown }): boolean {
  return (
    copy.schema_version === undefined ||
    copy.schema_version === null ||
    (typeof copy.schema_version === 'number' &&
      copy.schema_version < CURRENT_WORKFLOW_SCHEMA_VERSION)
  );
}

/** The refusal of a copy an older Realm registered — one owner of its words for the registry read and
 *  the listing (#627 W correction 2, 8.6 (c)); the arguments of `new WorkflowError(…)`. */
function legacyDefinitionParts(filePath: string): [string, WorkflowErrorOptions] {
  return [
    'This workflow was registered with an older version of Realm. ' +
      'Re-register it with: realm workflow register <path-to-workflow>',
    {
      code: 'STATE_LEGACY_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      // #729 PR-0 (T-21): the copy's path — the register way's `path` (a legacy copy is one the
      // registry knows the file of).
      details: { path: filePath },
    },
  ];
}

/**
 * issue #558 PR-T (review fold R1) — every probe failure class as a VALUE, so a consumer can narrow
 * an error's `details.class` without a cast. Both directions are checked at compile time: `satisfies`
 * keeps the list inside the union; `_ClassesExhaustive` keeps the union inside the list (a sixth
 * class fails `tsc` on BOTH lines — the #508 guard shape, never a widening `readonly T[]`).
 */
export const PROBE_FAILURE_CLASSES = [
  'missing',
  'unreadable',
  'not_a_file',
  'empty',
  'registry_broken',
] as const satisfies readonly ProbeFailureClass[];
type _ClassesExhaustive = ProbeFailureClass extends (typeof PROBE_FAILURE_CLASSES)[number]
  ? true
  : never;
const _classesExhaustive: _ClassesExhaustive = true;
void _classesExhaustive;

function isProbeFailureClass(value: unknown): value is ProbeFailureClass {
  return typeof value === 'string' && (PROBE_FAILURE_CLASSES as readonly string[]).includes(value);
}

/** The probe class a read failure carries — `undefined` for the parse, legacy and foreign classes,
 *  and for the facts of any resource other than a workflow copy (issue #719, C6: a damaged run
 *  file's `unreadable` and `empty` are not registry probe classes). */
export function probeClassOf(err: WorkflowError): ProbeFailureClass | undefined {
  const stored = storedFileFacts(err);
  const resource = stored !== undefined ? stored.resource : err.details['resource'];
  if (resource !== undefined && resource !== 'workflow_copy') return undefined;
  const cls = stored !== undefined ? stored.class : err.details['class'];
  return isProbeFailureClass(cls) ? cls : undefined;
}

const REREGISTER_ACT =
  're-register the workflow from its source (realm workflow register <path-to-workflow>)';

/**
 * issue #558 PR-T (review fold R1) — the repair ACT for a read failure, keyed on the CLASS, minted
 * ONCE here and read by the composer (`getWorkflowForRun`) and by `validate --registered`. It was
 * keyed on the CODE, and `STATE_WORKFLOW_UNREADABLE` covers three classes whose acts differ: a
 * file that cannot be read is made readable; a directory where the file belongs is removed and the
 * workflow re-registered; an unreadable registry DIRECTORY is made readable — `fix <path>` on all
 * three named no act (the review walk). The switch is EXHAUSTIVE over `ProbeFailureClass` (a sixth
 * class fails the `never` assignment after it — not TS2366: the return type admits `undefined`); the parse classes carry no probe class and share ONE act
 * (re-register is the only repair for a copy whose bytes are wrong — review fold C11). `missing`
 * self-remedies in its own sentence (the #456 hedge) and `legacy` carries its own "Re-register it
 * with: …", so neither gets a second clause. For the two permission errnos the act NAMES the
 * command (`chmod u+r` / `chmod u+rx`); for any other errno it names the requirement and the errno.
 *
 * A `STATE_WORKFLOW_UNREADABLE` minted anywhere else — an external `WorkflowRegistrar` behind the
 * #188 injection seam — carries no probe class and gets NO act, never a guess (LAW-r); such a store
 * omitting `path` would also render an empty subject. Both are that store's contract to keep.
 */
const PERMISSION_ERRNOS: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

/** The `reason` + `repair` pair a listing entry carries — one place, so the two listings agree. */
function reasonAndRepair(err: WorkflowError): { reason: string; repair?: string } {
  const r = repairActFor(err);
  return {
    reason: err.message,
    ...(r !== undefined
      ? { repair: r.alternative !== undefined ? `${r.act}; ${r.alternative}` : r.act }
      : {}),
  };
}

export interface RepairAct {
  /** The act; the composer appends the retry after it. */
  act: string;
  /** A conditioned alternative for the SAME bytes under a different history (the parse classes:
   *  a file nothing ever registered has no source to re-register from — `rm` is the only act,
   *  and it was named nowhere; the review walk looped on it). Rendered after the retry. */
  alternative?: string;
}

export function repairActFor(err: WorkflowError): RepairAct | undefined {
  // issue #719 (R7): a damaged RUN file gets no act here — re-registering or removing it would
  // free its run's key and orphan its side files; its own message carries its way out.
  const stored = storedFileFacts(err);
  if (stored?.resource === 'run_file') return undefined;
  const path = String(stored?.path ?? err.details['path'] ?? '');
  if (err.code === 'RESOURCE_FORMAT_INVALID')
    return {
      act: REREGISTER_ACT,
      alternative: `if it was never registered from a source, remove the file (rm ${path}) instead`,
    };
  if (err.code !== 'STATE_WORKFLOW_UNREADABLE') return undefined;
  const cls = probeClassOf(err);
  if (cls === undefined) return undefined;
  const errno = String(stored?.errno ?? err.details['errno'] ?? 'unknown');
  switch (cls) {
    case 'missing': // not this code — kept for exhaustiveness
      return undefined;
    case 'unreadable':
      return {
        act: PERMISSION_ERRNOS.has(errno)
          ? `make ${path} readable (chmod u+r ${path})`
          : `make ${path} readable (${errno})`,
      };
    case 'not_a_file':
      // The command is named: "remove the directory" as prose sent a walker to `rm <path>`
      // ("Is a directory", twice).
      return { act: `remove the directory at ${path} (rm -r ${path}), then ${REREGISTER_ACT}` };
    case 'empty': // not this code — kept for exhaustiveness
      return { act: REREGISTER_ACT };
    case 'registry_broken':
      // "readable" alone is a LOOP for a directory: `chmod u+r` leaves it unsearchable and the
      // identical screen comes back (the review walk did exactly that, twice). A directory needs
      // the search bit too — the act says so and names the command.
      return {
        act: PERMISSION_ERRNOS.has(errno)
          ? `make the registry directory ${path} readable and searchable (chmod u+rx ${path})`
          : `make the registry directory ${path} readable and searchable (${errno})`,
      };
  }
  // The return type admits `undefined`, so a missing arm would NOT be TS2366 here (executed: a
  // sixth class fell through silently) — this assignment is what fails `tsc` for it.
  const unhandled: never = cls;
  return unhandled;
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
    // issue #719 (C6): whitespace only is `empty`, as for a run file.
    if (raw.trim() === '')
      throw probeClassToError({ ok: false, class: 'empty', path: filePath }, workflowId);
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(raw);
    } catch {
      throw parseFailureError(filePath, { kind: 'not_json' });
    }
    // Correction 2 (3.7, 8.6 (d)): the shared check — a copy that is not a workflow is damaged here
    // and in the listing alike, never read as legacy.
    const fault = copyFault(parsedUnknown);
    if (fault !== undefined) throw parseFailureError(filePath, fault);
    const parsed = parsedUnknown as WorkflowDefinition;
    if (isLegacyDefinition(parsed)) {
      throw new WorkflowError(...legacyDefinitionParts(filePath));
    }
    // #627 W (R25, W-r2): the upper bound beside the lower one. A definition a LATER Realm wrote
    // (V bumps `schema_version` for the definitions that use `gate.answer_via`) may carry
    // requirements this version cannot read; reading it anyway would run it with those requirements
    // ignored — fail open. Refused here, so every reader (start, step, answer, inspect) refuses it
    // through this one gate and no gate it would open is ever opened. Its own code: the copy is not
    // legacy (STATE_LEGACY_FORMAT's meaning and remedy are for an OLDER format) and not damaged.
    if (isNewerDefinition(parsed)) {
      throw new WorkflowError(
        ...newerDefinitionParts(workflowId, filePath, parsed.schema_version as number),
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
      /** `newer` (#627 W correction 1, C3): a copy a later Realm registered — it parses, and this
       *  version refuses it at read (W-r2), so it is listed here with W-r2's reason, never as readable. */
      class: ProbeFailureClass | 'parse' | 'newer' | 'legacy';
      /** issue #558 PR-T — present only for the OS-error classes; `workflow list`'s per-class
       *  sentence names it. Absent for `parse`, `empty` and `not_a_file` (a directory is not an
       *  OS error — fabricating an errno is a false statement about the operating system). */
      errno?: string;
      reason: string;
      /** issue #558 PR-T (review fold R5) — the repair ACT for this entry's class (`repairActFor`),
       *  so both listings — `workflow list --json` and the MCP `list_workflows` — name it. Absent
       *  only for a class with no act. */
      repair?: string;
    }>;
    mismatched: Array<{ file: string; id: string }>;
  }> {
    const workflows: WorkflowDefinition[] = [];
    const unreadable: Array<{
      file: string;
      class: ProbeFailureClass | 'parse' | 'newer' | 'legacy';
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
            ...reasonAndRepair(probeClassToError(failure, this.dir)),
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
          ...reasonAndRepair(probeClassToError(probed, id)),
        });
        continue;
      }
      const entryPath = join(this.dir, entry);
      // issue #719 (C6): the read in its own `try` — a read failure after the probe (a race) is
      // `unreadable` with its errno, never "is not JSON".
      let raw: string;
      try {
        raw = readFileSync(entryPath, 'utf8');
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        const failure = {
          ok: false as const,
          class: 'unreadable' as const,
          ...(errno !== undefined ? { errno } : {}),
          path: entryPath,
        };
        unreadable.push({
          file: entry,
          class: 'unreadable',
          ...(errno !== undefined ? { errno } : {}),
          ...reasonAndRepair(probeClassToError(failure, id)),
        });
        continue;
      }
      if (raw.trim() === '') {
        unreadable.push({
          file: entry,
          class: 'empty',
          ...reasonAndRepair(probeClassToError({ ok: false, class: 'empty', path: entryPath }, id)),
        });
        continue;
      }
      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(raw);
      } catch {
        unreadable.push({
          file: entry,
          class: 'parse',
          ...reasonAndRepair(parseFailureError(entryPath, { kind: 'not_json' })),
        });
        continue;
      }
      const fault = copyFault(parsedUnknown);
      if (fault !== undefined) {
        // #819 (U2): every unreadable class names its repair — this one too.
        unreadable.push({
          file: entry,
          class: 'parse',
          ...reasonAndRepair(parseFailureError(entryPath, fault)),
        });
        continue;
      }
      const parsed = parsedUnknown as WorkflowDefinition;
      // Correction 2 (8.6 (c)): a copy an older Realm registered is listed with getSync's reason —
      // every run path refuses it, so the listing never shows it as readable.
      if (isLegacyDefinition(parsed)) {
        unreadable.push({
          file: entry,
          class: 'legacy',
          ...reasonAndRepair(new WorkflowError(...legacyDefinitionParts(entryPath))),
        });
        continue;
      }
      // Correction 1 (C3): a copy a later Realm registered is listed with W-r2's reason — every run
      // path refuses it (`getSync`), so the listing never shows it as readable.
      if (isNewerDefinition(parsed)) {
        unreadable.push({
          file: entry,
          class: 'newer',
          ...reasonAndRepair(
            new WorkflowError(
              ...newerDefinitionParts(id, entryPath, parsed.schema_version as number),
            ),
          ),
        });
        continue;
      }
      workflows.push(parsed);
      if (entry !== `${String(parsed.id)}.json`) {
        mismatched.push({ file: entry, id: String(parsed.id) });
      }
    }
    return { workflows, unreadable, mismatched };
  }
}

brandClass(JsonWorkflowStore, Symbol.for('@sensigo/realm/JsonWorkflowStore'), REALM_BRAND);

/**
 * #627 W (W-r2): the refusal of a copy a LATER Realm registered — one owner of its words and facts
 * for the registry read (`getSync`) and the listing (`listWithDiagnostics`, correction 1 C3), so both
 * say the same. The arguments of `new WorkflowError(…)`, so each site keeps that form.
 */
function newerDefinitionParts(
  workflowId: string,
  filePath: string,
  schemaVersion: number,
): [string, WorkflowErrorOptions] {
  return [
    `Workflow '${workflowId}' was registered by a later version of Realm (definition format ` +
      `${String(schemaVersion)}; this version reads up to ` +
      `${CURRENT_WORKFLOW_SCHEMA_VERSION}) — refused: this version would ignore requirements ` +
      'it cannot read. Use the Realm version that registered it, or register the ' +
      "workflow's source again with this version. Nothing was run.",
    {
      code: 'STATE_NEWER_FORMAT',
      category: 'STATE',
      agentAction: 'report_to_user',
      retryable: false,
      // Typed facts (MA 3, 2026-10-16): `details` stays empty for this code.
      facts: {
        scope: 'newer_definition',
        path: filePath,
        schema_version: schemaVersion,
        reads_up_to: CURRENT_WORKFLOW_SCHEMA_VERSION,
      },
    },
  ];
}

/**
 * issue #729 PR-0 (D3 A-5, D4 T-21): why a run's definition is absent, from the error a definition
 * read threw — the `definition_absent` entry's cause, one per {@link getWorkflowForRun} arm, and the
 * stored file's path where the store knows it (the unreadable, invalid and legacy copies; a workflow
 * that was never registered, or an agent's copy that is gone, has none). `undefined` for any other
 * error.
 */
export function definitionAbsenceOf(
  err: unknown,
  run: Pick<RunRecord, 'workflow_id'>,
):
  | {
      absent: DefinitionAbsence;
      workflow_id: string;
      path?: string;
      format?: { schema_version: number; reads_up_to: number };
    }
  | undefined {
  if (!(err instanceof WorkflowError)) return undefined;
  // #627 W (W-r2): a copy a later Realm wrote — the mirror of `legacy`, read from its typed facts.
  const newer = err.code === 'STATE_NEWER_FORMAT' ? newerDefinitionFactsOf(err) : undefined;
  if (newer !== undefined) {
    return {
      absent: 'newer',
      workflow_id: run.workflow_id,
      path: newer.path,
      format: { schema_version: newer.schema_version, reads_up_to: newer.reads_up_to },
    };
  }
  const filed = storedFileFacts(err)?.path ?? err.details['path'];
  const path = typeof filed === 'string' ? { path: filed } : {};
  switch (err.code) {
    case 'STATE_WORKFLOW_NOT_FOUND':
      return {
        absent: /-[0-9a-f]{16}$/.test(run.workflow_id) ? 'agent_copy_gone' : 'not_registered',
        workflow_id: run.workflow_id,
      };
    case 'STATE_WORKFLOW_UNREADABLE':
      return { absent: 'unreadable', workflow_id: run.workflow_id, ...path };
    case 'RESOURCE_FORMAT_INVALID':
      return { absent: 'format_invalid', workflow_id: run.workflow_id, ...path };
    case 'STATE_LEGACY_FORMAT':
      return { absent: 'legacy', workflow_id: run.workflow_id, ...path };
    default:
      return undefined;
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
  admitEntry('getWorkflowForRun', { store, storeKind: 'workflow store', parts: { run, opts } });
  try {
    return await store.get(run.workflow_id);
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    // #729 PR-0 (Part B): the way on from a run that waits on a question is carried as data on the
    // error (`remedy`, rendered by each door), never a command in the message. Correction 2 (3.1): it
    // is the REPAIR, not the answer — answering waits on the definition, as core's own listing says
    // (`respond` is `definition_absent`, remedy `[register]`) — so the remedy is the listing's
    // `register` way, with the copy's file when the error carries one.
    const gateRemedy = (): readonly WayOn[] | undefined => {
      const live = run.terminal_state === true ? undefined : run.pending_gate;
      if (live === undefined) return undefined;
      const absence = definitionAbsenceOf(err, run);
      // #819 (U5, U1): an agent's copy that is gone never had a file to register — its question can
      // never be answered, and the way on is ending the run by naming the gate.
      if (absence?.absent === 'agent_copy_gone') {
        return [{ verb: 'abandon', conditions: [], run_id: run.id, gate_id: live.gate_id }];
      }
      const path = absence?.path;
      const register: RegisterWay = {
        verb: 'register',
        conditions: [],
        workflow_id: run.workflow_id,
        run_id: run.id,
        ...(path !== undefined ? { path } : {}),
      };
      return [register];
    };
    const copy = (message: string, remedy?: readonly WayOn[]): WorkflowError => {
      const ways = remedy ?? gateRemedy();
      return new WorkflowError(message, {
        code: err.code,
        category: err.category,
        agentAction: err.agentAction,
        retryable: err.retryable,
        details: err.details,
        // #729 PR-0 (Amendment 7): a damaged copy's typed facts ride the copy — they moved from
        // `details` to `facts`, and the copy is what every caller reads them from.
        ...(err.facts !== undefined ? { facts: err.facts } : {}),
        ...(err.warnings !== undefined ? { warnings: err.warnings } : {}),
        ...(ways !== undefined ? { remedy: ways } : {}),
      });
    };

    /**
     * The repair clause, minted ONCE per code (a second hand-typed copy is the #444/#508 class).
     * `withRetry: false` is the terminal branch: nothing to retry, but the COPY is still broken
     * for every other run of that workflow, so the repair is still worth naming.
     */
    // A terminal run's leftover pending_gate (the #282 zombie class) is not answerable — only a
    // LIVE run's gate shapes the text below.
    const gate = run.terminal_state === true ? undefined : run.pending_gate;
    // The repair's closing act: the retry verb for a gate-less run; for a gate-waiting run the
    // gate itself, since that is what the operator was trying to do (review fold C12). #729 PR-0:
    // the answer is the error's `remedy` (a `respond` way), worded by the door that shows it.
    const then = gate === undefined ? opts.retryVerb : 'answer the gate';
    // Review fold R1: the act is keyed on the CLASS (`repairActFor`), never the code — three
    // classes share STATE_WORKFLOW_UNREADABLE and their acts differ. One joiner: the act, then
    // the retry. (`missing`/`legacy` yield no act — see `repairActFor`.)
    const repairClause = (withRetry: boolean): string | undefined => {
      const r = repairActFor(err);
      if (r === undefined) return undefined;
      return (
        `To repair: ${r.act}${withRetry ? `, then ${then}` : ''}` +
        `${r.alternative !== undefined ? `; ${r.alternative}` : ''}.`
      );
    };

    // The terminal conjunct: the six sites without `terminalOk` read the definition BEFORE their
    // own terminal check, so "retry" on a terminal run is a falsity. `terminalOk: true` is passed
    // at the SEVEN sites whose happy path IS terminal (replay, drain ×5, resume — `resume.ts:84`
    // refuses any phase outside RESUMABLE_PHASES = {failed, abandoned}, both terminal, BEFORE the
    // definition is read at `:97`).
    if (run.terminal_state === true && opts.terminalOk !== true) {
      const repair = repairClause(false);
      throw copy(
        `${withFullStop(err.message)} The run is terminal (${deriveRunPhase(run)}); there is nothing to ` +
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
    // #819 (U1): realm run abandon refuses a question that can still be answered; an agent's copy
    // that is gone leaves one that can never be answered, ended by naming its gate (the error's
    // remedy). A copy whose recorded source is gone is judged by the CLI's abandon, which reads it.
    const disposalSentence = (leadIn: string, never = false): string =>
      gate === undefined
        ? `${leadIn} realm run abandon ${run.id}.`
        : never
          ? `This run is waiting on human gate '${gate.step_name}', whose question can never be ` +
            `answered; end it by naming the gate: realm run abandon ${run.id} --gate ${gate.gate_id}.`
          : `This run is waiting on human gate '${gate.step_name}', which cannot be answered until ` +
            `its workflow can be read; realm run abandon refuses a run whose question can still be ` +
            `answered.`;

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
                `to register.${terminal ? '' : ` ${disposalSentence('To end the run:', true)}`}`,
            )
          : copy(
              // #729 PR-0 (T-21, #742): the reason is the `definition_absent { cause:
              // 'not_registered' }` entry's words, from the one composer — never a flag the command
              // in use lacks (the old text named `--register` to a `realm workflow run` run). The
              // way on is the `register` way, carried as data; its words below stay PR-2's.
              `${renderDefinitionAbsent({ workflow_id: run.workflow_id, cause: 'not_registered' })}. ` +
                `Register the workflow (realm workflow register <file>) and ${opts.retryVerb}.`,
              [{ verb: 'register', conditions: [], workflow_id: run.workflow_id, run_id: run.id }],
            );
      case 'STATE_WORKFLOW_UNREADABLE':
        throw copy(
          join(
            withFullStop(err.message),
            terminal
              ? undefined
              : gate === undefined
                ? // Review fold R7: the consequence, not a restatement — "This run's workflow cannot
                  // be read." repeated the store sentence beside it and read as a second fault.
                  `This run cannot continue until the copy is repaired. ${disposalSentence('To end the run:')}`
                : disposalSentence(''),
            repairClause(true),
          ),
        );
      case 'RESOURCE_FORMAT_INVALID':
        throw copy(
          join(
            withFullStop(err.message),
            terminal ? undefined : disposalSentence('To end the run:'),
            repairClause(true),
          ),
        );
      case 'STATE_LEGACY_FORMAT':
        // The store's own message already carries the re-register remedy (wrapping it again would
        // double-remedy — this function's JSDoc); a gate-waiting run is told what comes after it.
        throw copy(
          join(
            withFullStop(err.message),
            terminal ? undefined : disposalSentence('To end the run instead:'),
            terminal || gate === undefined ? undefined : 'Once re-registered, answer the gate.',
          ),
        );
      case 'STATE_NEWER_FORMAT':
        // #627 W (W-r2): the mirror of the legacy arm — the message carries its own two remedies
        // (the Realm version that registered it, or registering the source again with this one);
        // a gate-waiting run is told what comes after it.
        throw copy(
          join(
            withFullStop(err.message),
            terminal ? undefined : disposalSentence('To end the run instead:'),
            terminal || gate === undefined ? undefined : 'Once re-registered, answer the gate.',
          ),
        );
      default:
        throw err;
    }
  }
}
