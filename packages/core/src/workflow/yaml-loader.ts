// Workflow YAML loader — parses workflow.yaml files into typed WorkflowDefinition objects.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { Ajv } from 'ajv';
import type {
  WorkflowDefinition,
  TemplateDefinition,
  TriggerRule,
  JsonSchema,
} from '../types/workflow-definition.js';
import {
  KNOWN_STEP_KEYS,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_RETRY_KEYS,
  KNOWN_GATE_KEYS,
} from '../types/workflow-definition.js';
import { WorkflowError } from '../types/workflow-error.js';
import {
  findUnknownKeys,
  renderLoaderWarning,
  resolveSeverity,
  closestKey,
  type LoaderWarning,
} from './diagnostics.js';
import { createSourcePositionCollector, type SourcePositionMap } from './source-positions.js';
import { resolveTemplates } from './template-resolver.js';
import type { ExtensionRegistry } from '../extensions/registry.js';
import { normalizeTriggerFilter, validateTriggerStructure } from './trigger-schema.js';
import { splitComparison, isPathShaped } from '../engine/comparison-expr.js';
import { DEFAULT_EXECUTION_TIMEOUT_SECONDS } from '../engine/claim-liveness.js';
import { validateOutputSchema } from '../validation/input-schema.js';
import {
  assessStructuredOutputEligibility,
  renderIneligibleMessage,
} from './structured-output-eligibility.js';

type ConditionSurface = 'when' | 'abort_unless' | 'preconditions';

/**
 * Validate one condition leaf at load time using the shared quote-aware splitter (the SAME split
 * used at runtime). Rejects compound `and`/`or`, multiple operators, and non-path LHS. For `when`,
 * also enforces the direct-`depends_on` reference check (Change 2). Pushes actionable errors.
 */
function validateConditionLeaf(
  surface: ConditionSurface,
  leaf: string,
  stepName: string,
  dependsOn: string[],
  errors: string[],
  /**
   * Appends the step's source line to a message (issue #392). REQUIRED rather than optional so
   * the compiler names every call site if this ever gains another one — an omitted resolver
   * would silently drop positions, which is exactly the kind of quiet gap this repo keeps
   * finding the hard way.
   */
  withLine: (stepName: string, message: string) => string,
): void {
  const split = splitComparison(leaf);

  if (split.kind === 'invalid') {
    if (split.reason === 'compound_and' || split.reason === 'compound_or') {
      const kw = split.reason === 'compound_and' ? 'and' : 'or';
      const listForm = (split.parts ?? [leaf]).map((p) => `    - "${p}"`).join('\n');
      errors.push(
        withLine(
          stepName,
          `Step '${stepName}': '${surface}' uses unsupported '${kw}' — write it as a list:\n` +
            `  ${surface}:\n${listForm}`,
        ),
      );
    } else if (split.reason === 'multiple_operators') {
      errors.push(
        withLine(
          stepName,
          `Step '${stepName}': '${surface}' leaf '${leaf}' has multiple comparison operators — each leaf must be a single comparison.`,
        ),
      );
    } else {
      errors.push(withLine(stepName, `Step '${stepName}': '${surface}' leaf must not be empty.`));
    }
    return;
  }

  if (split.kind === 'path') {
    // A precondition is always a comparison; a bare path is not a valid precondition. This check
    // stays FIRST (before the `$settlement` branch below) — a bare `$settlement.<dep>.<field>` on
    // `preconditions` is refused HERE, for the pre-existing "must be a comparison" reason, not the
    // $settlement one-hop reason (issue #220 §4c pin kk: the precondition witness for a
    // $settlement leaf must use the comparison spelling).
    if (surface === 'preconditions') {
      errors.push(
        withLine(
          stepName,
          `Step '${stepName}': precondition '${leaf}' must be a comparison (e.g. "step.field >= 1").`,
        ),
      );
      return;
    }
    // issue #220 §4c (PR-3): `$settlement.<dep>.<field>` handling lives HERE, in
    // validateConditionLeaf, branching on the LHS first segment — NOT in isPathShaped (a
    // documented generic zero-dependency splitter; embedding `$settlement` there would widen its
    // contract for every caller) and NOT as an arm on validateWhenReference (invoked only under
    // `surface === 'when'` — an arm there would never fire for abort_unless/preconditions). This
    // fires on ALL THREE surfaces since it runs BEFORE the generic isPathShaped check below.
    if (split.path.split('.')[0] === '$settlement') {
      validateSettlementReference(split.path, surface, leaf, stepName, dependsOn, errors, withLine);
      return;
    }
    if (!isPathShaped(split.path)) {
      errors.push(
        withLine(
          stepName,
          `Step '${stepName}': '${surface}' leaf '${leaf}' is not a valid path or comparison.`,
        ),
      );
      return;
    }
    if (surface === 'when')
      validateWhenReference(split.path, stepName, dependsOn, errors, withLine);
    return;
  }

  // comparison
  if (split.lhsPath.split('.')[0] === '$settlement') {
    validateSettlementReference(
      split.lhsPath,
      surface,
      leaf,
      stepName,
      dependsOn,
      errors,
      withLine,
    );
    return;
  }
  if (!isPathShaped(split.lhsPath)) {
    errors.push(
      withLine(
        stepName,
        `Step '${stepName}': '${surface}' leaf '${leaf}' must have a path on the left-hand side (got '${split.lhsPath}').`,
      ),
    );
    return;
  }
  if (surface === 'when')
    validateWhenReference(split.lhsPath, stepName, dependsOn, errors, withLine);
}

/**
 * issue #220 §4c (PR-3): validates a `$settlement.<dep>.<field>` reference reached from ANY of
 * the three condition surfaces (when/abort_unless/preconditions) — unlike the legacy
 * depends_on/run.params check ({@link validateWhenReference}, `when`-only), this fires on all
 * three because it is invoked directly from {@link validateConditionLeaf}, before the
 * `surface === 'when'` gate. The caller must NOT fall through to the generic `isPathShaped` check
 * afterward (which rejects `$` outright) — this function's callers always `return` immediately.
 */
function validateSettlementReference(
  path: string,
  surface: ConditionSurface,
  leaf: string,
  stepName: string,
  dependsOn: string[],
  errors: string[],
  /**
   * Appends the step's source line to a message (issue #392). REQUIRED rather than optional so
   * the compiler names every call site if this ever gains another one — an omitted resolver
   * would silently drop positions, which is exactly the kind of quiet gap this repo keeps
   * finding the hard way.
   */
  withLine: (stepName: string, message: string) => string,
): void {
  // Path-shape: a NARROWING for this ONE prefix only (never a general `$` allowance) — the
  // remainder after `$settlement` must itself be path-shaped. Rejects `$foo`, a bare `$`, and
  // garbage remainders like `$settlement.a b`.
  //
  // issue #220 PR-3 ReDoS correction (CodeQL HIGH, CWE-1333): the inner character class must NOT
  // include `.` — `[A-Za-z0-9_.-]` let a `.` be consumed either by the inner `*` or by the next
  // outer-group iteration's leading `\.`, an ambiguous nested quantifier causing catastrophic
  // backtracking on inputs like `$settlement.a.a.a…!`. With `.` removed from the inner class
  // (`[A-Za-z0-9_-]`), each `.` can ONLY start a new group — the parse is unambiguous, linear-time,
  // no backtracking. Accepts every valid `$settlement.<dep>.<field>` path identically; stricter
  // only on pathological consecutive dots (`$settlement.dep..field`), which is more correct.
  if (!/^\$settlement(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path)) {
    errors.push(
      withLine(
        stepName,
        `Step '${stepName}': '${surface}' leaf '${leaf}' has an invalid '$settlement' reference ` +
          `'${path}' — expected '$settlement.<dep>.<field>'.`,
      ),
    );
    return;
  }
  // One-hop (§4c-S4): the SECOND segment must be a DIRECT dependency of this step.
  const dep = path.split('.')[1];
  if (dep === undefined) {
    errors.push(
      withLine(
        stepName,
        `Step '${stepName}': '${surface}' leaf '${leaf}' references '$settlement' with no ` +
          `dependency segment — expected '$settlement.<dep>.<field>' where '<dep>' is a direct dependency.`,
      ),
    );
    return;
  }
  if (!dependsOn.includes(dep)) {
    errors.push(
      withLine(
        stepName,
        `Step '${stepName}': '${surface}' references '$settlement.${dep}' — '${dep}' is not in ` +
          `its depends_on [${dependsOn.join(', ')}]. '$settlement' paths must reference a direct ` +
          `dependency (one-hop rule).`,
      ),
    );
  }
}

/**
 * Change 2 (when-only): a `when` leaf's `step.field` reference must resolve to `run.params.*` or to a
 * step in this step's DIRECT `depends_on` (one-hop membership — no graph traversal). Field names are
 * not checked (agent-step outputs aren't statically declared).
 */
function validateWhenReference(
  path: string,
  stepName: string,
  dependsOn: string[],
  errors: string[],
  /**
   * Appends the step's source line to a message (issue #392). REQUIRED rather than optional so
   * the compiler names every call site if this ever gains another one — an omitted resolver
   * would silently drop positions, which is exactly the kind of quiet gap this repo keeps
   * finding the hard way.
   */
  withLine: (stepName: string, message: string) => string,
): void {
  const first = path.split('.')[0]!;
  if (first === 'run') {
    if (!(path === 'run.params' || path.startsWith('run.params.'))) {
      errors.push(
        withLine(
          stepName,
          `Step '${stepName}': 'when' references '${path}' — only 'run.params.*' is available from 'run'.`,
        ),
      );
    }
    return;
  }
  if (!dependsOn.includes(first)) {
    errors.push(
      withLine(
        stepName,
        `Step '${stepName}': 'when' references step '${first}' which is not in its depends_on [${dependsOn.join(', ')}]. Add it to depends_on or use 'run.params.*'.`,
      ),
    );
  }
}

/** Bumped on every breaking change to WorkflowDefinition's serialized format. */
export const CURRENT_WORKFLOW_SCHEMA_VERSION = 1;

/**
 * Ajv-strict schema for one `services:` entry — CLOSED key set (`adapter`, `trust`,
 * `rate_limit`). `auth`/`token_from` get a targeted migration rejection BEFORE this schema
 * runs (removed in v0.14.0 — credentials bind in the deployment manifest). rate_limit's
 * field-level numeric rules keep their existing dedicated checks below.
 */
const SERVICE_ENTRY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['adapter'],
  properties: {
    adapter: { type: 'string', minLength: 1 },
    trust: { enum: ['engine_delivered', 'engine_managed', 'agent_provided'] },
    rate_limit: { type: 'object' },
  },
};

const VALID_EXECUTIONS = new Set(['auto', 'agent', 'guard', 'finalizer']);
const VALID_FINALIZER_TRIGGERS = new Set([
  'complete',
  'fail',
  'abort',
  'always',
  // issue #302: author-opt-in — fires IN ADDITION to complete/always on a complete seal that
  // still carries failed_steps (a designed-recovery seal, #304's own class); never on a clean
  // complete.
  'completed_with_failed_steps',
]);
// issue #220 (PR-2): the full set of recognized validation_exhaustion sub-keys.
const KNOWN_VALIDATION_EXHAUSTION_KEYS = ['threshold', 'mode', 'default_output'];
const VALID_SERVICE_METHODS = new Set(['fetch', 'create', 'update', 'delete']);
const VALID_TRIGGER_RULES = new Set<TriggerRule>([
  'all_success',
  'all_failed',
  'all_done',
  'one_failed',
  'one_success',
  'none_failed',
]);

/**
 * JSON Schema (Ajv strict) for the top-level `extensions` key: a non-empty module path or a
 * non-empty array of them. Relative-path enforcement is a separate explicit check (isAbsolute)
 * so the error message can be actionable.
 */
const EXTENSIONS_JSON_SCHEMA = {
  anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  ],
};

/**
 * Validates the authored `extensions` value: `string | string[]`, every entry a non-empty
 * RELATIVE path. Returns actionable error strings (empty = valid).
 */
function validateExtensionsDeclaration(rawExtensions: unknown): string[] {
  const errors: string[] = [];
  const ajv = new Ajv({ strict: true });
  if (!ajv.validate(EXTENSIONS_JSON_SCHEMA, rawExtensions)) {
    errors.push(
      `'extensions' must be a non-empty module path or a non-empty array of module paths ` +
        `(e.g. extensions: ./dist/registry.js)`,
    );
    return errors;
  }
  const entries = typeof rawExtensions === 'string' ? [rawExtensions] : (rawExtensions as string[]);
  for (const entry of entries) {
    if (entry.trim() === '') {
      errors.push(`'extensions' entries must be non-empty module paths`);
    } else if (isAbsolute(entry)) {
      errors.push(
        `'extensions' entry '${entry}' is an absolute path — extension modules must be declared ` +
          `RELATIVE to the workflow directory (e.g. ../dist/registry.js)`,
      );
    }
  }
  return errors;
}

/**
 * Finds the trust root for extension resolution: the nearest ancestor of `dir` (inclusive)
 * containing `package.json` or `.git`; falls back to `dir` itself when no such ancestor exists.
 * Derived once, at registration time, from an operator-given path — never at execution time.
 * Exported so CLI paths that don't stamp a definition (e.g. `realm workflow validate` on an
 * extension-free workflow) can resolve the same trust root for the orphaned-manifest guard.
 * Pure `package.json`/`.git` walk — zero manifest knowledge.
 */
export function findTrustRoot(dir: string): string {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, 'package.json')) || existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

/**
 * issue #424 — attaches the live loader warnings to an error on its way out.
 *
 * Two chokepoints call this (one in `parseWorkflowString`, one in `loadWorkflowFromFileCore`),
 * which is why it exists rather than each throw site building its own error with a `warnings`
 * option: there are eleven throw sites across this file plus four more in template-resolver.ts,
 * the warnings array is out of scope at most of them, and a chokepoint covers every future one
 * for free. The non-empty guard makes the classification automatic — a throw that happens before
 * any warning could exist attaches nothing, by construction rather than by a rule someone has to
 * remember.
 *
 * Attach-once: an inner chokepoint's attachment survives the outer one re-catching the same
 * error, so a file-based load reports the warnings from the parse that produced it rather than
 * an emptier outer set.
 */
export function attachLoaderWarnings(err: WorkflowError, warnings: readonly LoaderWarning[]): void {
  if (warnings.length === 0) return;
  if (err.warnings !== undefined) return;
  err.warnings = warnings;
}

/**
 * Pure core of loadWorkflowFromFile (issue #169): parses + resolves everything a file-based load
 * needs, but never prints and never chooses between the two public presentations — it always
 * returns the definition alongside every collected LoaderWarning. `loadWorkflowFromFile` (prints
 * via renderLoaderWarning, returns just the definition — byte-identical default behavior, the
 * non-breaking invariant) and `loadWorkflowFromFileWithDiagnostics` (prints nothing, returns both)
 * are both thin wrappers over this.
 * @throws WorkflowError on read failure or structural validation errors.
 */
function loadWorkflowFromFileCore(
  filePath: string,
  registry?: ExtensionRegistry,
): { definition: WorkflowDefinition; warnings: LoaderWarning[] } {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkflowError(`Failed to read workflow file: ${message}`, {
      code: 'RESOURCE_FETCH_FAILED',
      category: 'RESOURCE',
      agentAction: 'report_to_user',
      retryable: false,
    });
  }
  const { definition, warnings } = parseWorkflowString(content, registry, {
    allowExtensions: true,
  });
  // issue #424 — CHOKEPOINT 2. Everything past the parse can throw with `warnings` already
  // populated (a missing agent_profile, a bad workflow_context source), and those warnings used
  // to unwind with the stack: `register` on a file with a typo AND a missing profile printed the
  // profile error alone, so the author fixed it, re-ran, and only then learned about the typo.
  // The parse call itself is deliberately OUTSIDE this try — chokepoint 1 inside
  // `parseWorkflowString` owns those throws and has already attached, and attach-once means its
  // richer set survives.
  try {
    // Resolve agent profiles — only possible when we have a file path.
    const workflowDir = dirname(resolve(filePath));
    const profilesDir =
      definition.profiles_dir !== undefined
        ? resolve(workflowDir, definition.profiles_dir)
        : join(workflowDir, 'profiles');

    const resolvedProfiles: Record<string, { content: string; content_hash: string }> = {};
    const profileErrors: string[] = [];

    for (const [stepName, step] of Object.entries(definition.steps)) {
      if (step.agent_profile === undefined) continue;
      const profileName = step.agent_profile;
      if (profileName in resolvedProfiles) continue;

      const profilePath = join(profilesDir, `${profileName}.md`);
      let profileContent: string;
      try {
        profileContent = readFileSync(profilePath, 'utf8');
      } catch {
        profileErrors.push(
          `Step '${stepName}': agent_profile '${profileName}' not found. Searched: ${profilePath}`,
        );
        continue;
      }

      const contentHash = createHash('sha256').update(profileContent).digest('hex');
      resolvedProfiles[profileName] = { content: profileContent, content_hash: contentHash };
    }

    if (profileErrors.length > 0) {
      throw new WorkflowError(`Invalid workflow: ${profileErrors.join('; ')}`, {
        // issue #425: the pre-join strings, so a render can list them one per line. Two missing
        // profiles are two problems, not one long sentence.
        errors: [...profileErrors],
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    if (Object.keys(resolvedProfiles).length > 0) {
      definition.resolved_profiles = resolvedProfiles;
    }

    // Validate context_wrapper if present.
    if (definition.context_wrapper !== undefined) {
      const VALID_WRAPPER_FORMATS = new Set(['xml', 'brackets', 'none']);
      if (!VALID_WRAPPER_FORMATS.has(definition.context_wrapper)) {
        throw new WorkflowError(
          `Invalid context_wrapper '${String(definition.context_wrapper)}'; must be 'xml', 'brackets', or 'none'`,
          {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }
    }

    // Validate and resolve workflow_context entry paths.
    if (definition.workflow_context !== undefined) {
      for (const [name, entry] of Object.entries(definition.workflow_context)) {
        if (name.endsWith('.raw')) {
          throw new WorkflowError(
            `workflow_context entry names must not end with '.raw' (found: '${name}')`,
            {
              code: 'VALIDATION_WORKFLOW_SCHEMA',
              category: 'VALIDATION',
              agentAction: 'report_to_user',
              retryable: false,
            },
          );
        }
        if (!/^[\w.]+$/.test(name)) {
          throw new WorkflowError(
            `workflow_context entry name '${name}' is invalid; names must match [\\w.]+ (underscores and dots only — no hyphens)`,
            {
              code: 'VALIDATION_WORKFLOW_SCHEMA',
              category: 'VALIDATION',
              agentAction: 'report_to_user',
              retryable: false,
            },
          );
        }
        const rawEntry = entry as unknown as Record<string, unknown>;
        const rawSource = rawEntry['source'] as Record<string, unknown> | undefined;
        if (rawSource === undefined || typeof rawSource['path'] !== 'string') {
          throw new WorkflowError(`workflow_context.${name}.source.path is required`, {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          });
        }
        // Resolve relative path to absolute.
        entry.source.path = resolve(workflowDir, rawSource['path'] as string);
      }
    }

    // Auto-register schema.json if present and not explicitly declared.
    const schemaPath = join(workflowDir, 'schema.json');
    if (existsSync(schemaPath) && definition.workflow_context?.['schema'] === undefined) {
      definition.workflow_context ??= {};
      definition.workflow_context['schema'] = {
        source: { path: schemaPath },
        description: 'Auto-registered schema.json from workflow directory',
      };
    }

    // Resolution metadata: stamped for EVERY file-loaded definition (v0.14) — trust_root is
    // the deployment-manifest anchor (`<trust_root>/realm.yaml`), needed by extension-free
    // workflows that consume manifest-constructed adapters by name. Core resolves/stores
    // PATHS only — it never imports modules or reads the manifest; that is the CLI's job.
    definition.source_dir = workflowDir;
    definition.trust_root = findTrustRoot(workflowDir);
    if (definition.extensions !== undefined) {
      definition.extensions =
        typeof definition.extensions === 'string' ? [definition.extensions] : definition.extensions;
    }

    definition.origin = 'human';
  } catch (err) {
    if (err instanceof WorkflowError) attachLoaderWarnings(err, warnings);
    throw err;
  }

  return { definition, warnings };
}

/**
 * Loads a WorkflowDefinition from a YAML file on disk. UNCHANGED signature/return type — the
 * non-breaking invariant (issue #169): every existing execution caller keeps compiling and
 * printing warnings for free. Structured warnings are reachable only via
 * `loadWorkflowFromFileWithDiagnostics`.
 * @throws WorkflowError on read failure or structural validation errors.
 */
export function loadWorkflowFromFile(
  filePath: string,
  registry?: ExtensionRegistry,
): WorkflowDefinition {
  const { definition, warnings } = loadWorkflowFromFileCore(filePath, registry);
  for (const w of warnings) console.warn(renderLoaderWarning(w));
  return definition;
}

/**
 * Same as `loadWorkflowFromFile`, but prints nothing and returns every collected LoaderWarning
 * alongside the definition (issue #169). Opt-in for callers that want to surface warnings
 * themselves (validate/register/watch/`--strict`) instead of the default console.warn behavior.
 */
export function loadWorkflowFromFileWithDiagnostics(
  filePath: string,
  registry?: ExtensionRegistry,
): { definition: WorkflowDefinition; warnings: LoaderWarning[] } {
  return loadWorkflowFromFileCore(filePath, registry);
}

/**
 * Loads a WorkflowDefinition from a YAML string. UNCHANGED signature/return type — the
 * non-breaking invariant (issue #169): every existing execution caller keeps compiling and
 * printing warnings for free. Structured warnings are reachable only via
 * `loadWorkflowFromStringWithDiagnostics`.
 * Validates structure and DAG dependency references.
 * A declared `extensions` key is a hard load error — extensions require file-based loading
 * (no directory context exists to resolve relative extension module paths against).
 * @throws WorkflowError on parse failure or structural validation errors.
 */
export function loadWorkflowFromString(
  content: string,
  registry?: ExtensionRegistry,
): WorkflowDefinition {
  const { definition, warnings } = parseWorkflowString(content, registry, {
    allowExtensions: false,
  });
  for (const w of warnings) console.warn(renderLoaderWarning(w));
  return definition;
}

/**
 * Same as `loadWorkflowFromString`, but prints nothing and returns every collected LoaderWarning
 * alongside the definition (issue #169).
 */
export function loadWorkflowFromStringWithDiagnostics(
  content: string,
  registry?: ExtensionRegistry,
): { definition: WorkflowDefinition; warnings: LoaderWarning[] } {
  return parseWorkflowString(content, registry, { allowExtensions: false });
}

/**
 * Detects cycles in a directed graph (issue #153), given as an adjacency map of
 * stepName -> its outgoing dependency edges (already filtered to valid DAG edges only — see
 * the call site). Depth-first search with three-state coloring (white = unvisited, gray = on the
 * current DFS path, black = fully explored) plus an explicit path stack: a back-edge to a GRAY
 * node closes a cycle, and the stack from that node's position onward IS the cycle, in order.
 *
 * Start nodes are iterated in `edges`' insertion (Map) order for deterministic output. Each
 * distinct cycle is reported once — deduped by a rotation-normalized key, since a duplicate
 * `depends_on` entry (the same dep listed twice) can otherwise cause the identical back-edge to
 * fire twice from the same DFS position.
 *
 * Pure and module-private — unit-tested directly (see yaml-loader.test.ts).
 */
function detectDependencyCycles(edges: Map<string, string[]>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of edges.keys()) color.set(node, WHITE);

  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  const stack: string[] = [];

  const normalizeCycleKey = (cyclePath: string[]): string => {
    // cyclePath is e.g. ['a', 'b', 'c', 'a'] (first === last, the closing repeat). Normalize by
    // rotation over the distinct nodes so a→b→c→a and b→c→a→b dedupe to the same key.
    const nodes = cyclePath.slice(0, -1);
    let best = nodes;
    for (let i = 1; i < nodes.length; i++) {
      const rotated = [...nodes.slice(i), ...nodes.slice(0, i)];
      if (rotated.join('\0') < best.join('\0')) best = rotated;
    }
    return best.join('\0');
  };

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of edges.get(node) ?? []) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        const idx = stack.indexOf(dep);
        const cyclePath = [...stack.slice(idx), dep];
        const key = normalizeCycleKey(cyclePath);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cyclePath);
        }
      } else if (depColor === WHITE) {
        dfs(dep);
      }
      // BLACK: already fully explored via another path — no cycle through this edge.
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of edges.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }

  return cycles;
}

/**
 * Shared YAML → WorkflowDefinition parser. `allowExtensions` distinguishes file-based loading
 * (extensions permitted — a directory context exists) from string-based loading (hard error,
 * fired before any other processing).
 *
 * PURE (issue #169): never prints, never throws on a warning — every non-fatal condition is
 * collected into the returned `warnings: LoaderWarning[]` instead of console.warn'd directly.
 * Callers (loadWorkflowFromFile/loadWorkflowFromFileCore, loadWorkflowFromString) decide whether
 * to print (the default, byte-identical wrappers) or surface the structured array
 * (the `...WithDiagnostics` variants).
 * @throws WorkflowError on parse failure or structural validation errors.
 */
function parseWorkflowString(
  content: string,
  registry: ExtensionRegistry | undefined,
  opts: { allowExtensions: boolean },
): { definition: WorkflowDefinition; warnings: LoaderWarning[] } {
  // Step 1: Parse YAML
  //
  // issue #392: the position collector rides THIS parse via js-yaml's own listener — there is no
  // second parse and no parser change. If the parse throws, `finish()` is never reached and every
  // position is simply absent, which is the correct answer for a file that did not parse.
  const positions = createSourcePositionCollector();
  let raw: unknown;
  try {
    raw = load(content, { listener: positions.listener });
  } catch (err) {
    throw new WorkflowError(
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      {
        code: 'RESOURCE_FORMAT_INVALID',
        category: 'RESOURCE',
        agentAction: 'report_to_user',
        retryable: false,
      },
    );
  }

  const errors: string[] = [];
  const warnings: LoaderWarning[] = [];
  // issue #424 — CHOKEPOINT 1. Every throw from here down unwinds past a populated `warnings`
  // array, and used to drop it: a workflow with a prohibited key AND a `dependson` typo reported
  // the prohibition alone. This also covers the template-resolver's own throws, which cross this
  // frame and are unreachable from any sweep of this file.
  try {
    // Finalised after the parse succeeded; resolves a semantic path to its place in the source.
    const sourceMap: SourcePositionMap = positions.finish();
    /**
     * Appends ` (step at line N)` when the step's own key can be placed, and nothing when it cannot
     * (issue #392). Used at PUSH time, never at join time — once messages are joined into one
     * string the step each came from is no longer recoverable.
     *
     * The suffix names the STEP because that is the only position this helper ever has, and saying
     * so is the point (issue #420). Across the loader the two forms are univocal:
     *
     *   `(line N)`         — the OFFENDING KEY's own line. Minted by `withKeyLine`'s first rung
     *                        below, and by the unknown-key warnings (`renderUnknownKeyMessage`),
     *                        which is key-exact-or-absent by construction: every `findUnknownKeys`
     *                        call site passes a `positionOf` that resolves the offending key's own
     *                        path, with no step fallback anywhere.
     *   `(step at line N)` — the STEP's line. This helper, and `withKeyLine`'s fallback rung.
     *
     * Before that split both rungs rendered `(line N)`, so an author could not tell a cite that
     * pointed AT the refused field from one that pointed at the declaration above it. The
     * structured channel (`line`/`column`/`endLine`/`endColumn`) is unaffected — it always carried
     * the distinction; only the prose was ambiguous.
     */
    const withStepLine = (stepName: string, message: string): string => {
      const line = sourceMap.posOf(['steps', stepName])?.line;
      return line === undefined ? message : `${message} (step at line ${line})`;
    };

    /**
     * Like `withStepLine`, but names the OFFENDING KEY's own line (issue #417).
     *
     * For a key-scoped refusal the step's line is the wrong place to send someone: a long step has
     * the key twenty lines below its own name, and the author reading `(line 40)` looks at the
     * declaration rather than at the field being refused. The position map records every pairable
     * mapping key, so the key's own line is available wherever the step's is.
     *
     * Falls back to the step's line, and then to no position at all — and the two real shapes land
     * on DIFFERENT rungs, which is why both are pinned. A step body assembled through a merge key
     * (`<<: *anchor`) leaves the KEY unpairable while the step's own name is still placeable, so it
     * falls back to the step's line. A `use_template` step, whose keys are synthesized, exists at no
     * line in the file at all and carries no position. Neither guesses — a wrong line number sends
     * an author confidently to the wrong place, which is worse than sending them nowhere.
     *
     * The two rungs render DIFFERENTLY (issue #420): rung 1 is ` (line N)`, the key's own line;
     * rung 2 is ` (step at line N)`, the step's — the same vocabulary `withStepLine` above
     * documents in full. They were previously indistinguishable, which made the fallback silently
     * claim to be a key-exact cite. The two lookups are separate rather than one `??` chain for
     * exactly that reason: a single chain cannot report WHICH rung answered.
     */
    const withKeyLine = (stepName: string, key: string, message: string): string => {
      const keyLine = sourceMap.posOf(['steps', stepName, key])?.line;
      if (keyLine !== undefined) return `${message} (line ${keyLine})`;
      const stepLine = sourceMap.posOf(['steps', stepName])?.line;
      if (stepLine !== undefined) return `${message} (step at line ${stepLine})`;
      return message;
    };

    // Step 2: Top-level validation
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new WorkflowError('Invalid workflow: Workflow must be a non-null object', {
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    const doc = raw as Record<string, unknown>;

    // WARN (do not reject) on a key that isn't authorable — checked against KNOWN_WORKFLOW_KEYS
    // ONLY (not RUNTIME_ONLY_WORKFLOW_KEYS), and BEFORE any loader-stamped field is added below.
    // Deliberately excluding runtime-only keys from "known" here means hand-authoring one (e.g.
    // `schema_version:` or `model:` in YAML) warns too — those fields are stamped by the loader
    // and any authored value is silently overwritten/ignored, which is exactly the kind of mistake
    // this check exists to surface (issue #144). Non-breaking by design: siblings #170
    // (hard-reject) and #169 (structured warnings channel) are deliberately out of scope here.
    {
      const workflowId = typeof doc['id'] === 'string' ? doc['id'] : '<unknown>';
      warnings.push(
        ...findUnknownKeys(doc, KNOWN_WORKFLOW_KEYS, {
          scope: 'workflow',
          code: 'UNKNOWN_WORKFLOW_KEY',
          id: workflowId,
          positionOf: (key) => sourceMap.posOf([key]),
        }),
      );
    }

    // Project extensions: hard error for string-based loading (fires before any other
    // processing); shape validation (string | string[], relative-only) for file-based loading.
    if ('extensions' in doc && doc['extensions'] !== undefined) {
      if (!opts.allowExtensions) {
        throw new WorkflowError(
          `Invalid workflow: 'extensions' requires file-based loading — no directory context is ` +
            `available to resolve extension module paths. Register this workflow from its YAML ` +
            `file (realm workflow register <path>).`,
          {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          },
        );
      }
      errors.push(...validateExtensionsDeclaration(doc['extensions']));
    }

    const REQUIRED_TOP_LEVEL = ['id', 'name', 'version', 'steps'];
    for (const field of REQUIRED_TOP_LEVEL) {
      if (!(field in doc)) {
        errors.push(`Missing required field: '${field}'`);
      }
    }

    if ('version' in doc && typeof doc['version'] !== 'number') {
      errors.push(`'version' must be a number`);
    }
    if (
      'steps' in doc &&
      (typeof doc['steps'] !== 'object' || doc['steps'] === null || Array.isArray(doc['steps']))
    ) {
      errors.push(`'steps' must be a non-null object`);
    }

    if (errors.length > 0) {
      throw new WorkflowError(`Invalid workflow: ${errors.join('; ')}`, {
        // issue #425: the pre-join strings — see the profile collector above.
        errors: [...errors],
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }

    // Step 1b: Resolve template instantiations before validation.
    const rawTemplates = (doc['templates'] ?? {}) as Record<string, TemplateDefinition>;
    if (Object.keys(rawTemplates).length > 0 || hasUseTemplateInSteps(doc['steps'])) {
      doc['steps'] = resolveTemplates(doc['steps'] as Record<string, unknown>, rawTemplates);
    }

    const stepsRaw = doc['steps'] as Record<string, unknown>;

    // Finalizer-bearing workflows write every claim `deadline: null` (issue #101), so a per-step
    // `idempotent` hint is INERT there (never cron-reclaimable). Used only to WARN below.
    const hasFinalizerStep = Object.values(stepsRaw).some(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        (s as Record<string, unknown>)['execution'] === 'finalizer',
    );

    // Step 3: Per-step validation
    for (const [stepName, stepRaw] of Object.entries(stepsRaw)) {
      if (typeof stepRaw !== 'object' || stepRaw === null || Array.isArray(stepRaw)) {
        errors.push(withStepLine(stepName, `Step '${stepName}' must be an object`));
        continue;
      }
      const step = stepRaw as Record<string, unknown>;

      // issue #220 §4c (PR-3): HOISTED out of the `when`-only block below (was block-local there) so
      // ALL THREE condition surfaces (when/abort_unless/preconditions) can thread the real
      // depends_on list into validateConditionLeaf's `$settlement` one-hop check. Previously
      // abort_unless/preconditions passed a literal `[]` (no reference validation existed for them
      // at all); the legacy when-only depends_on/run.params check (validateWhenReference) is
      // UNCHANGED — it still fires ONLY for `surface === 'when'`. This is a LIFT, not a new
      // computation — byte-identical to the previous block-local `dependsOn` for `when`'s own use.
      const dependsOn = Array.isArray(step['depends_on'])
        ? (step['depends_on'] as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];

      // WARN (do not reject) on an unknown step key — runs after template resolution above, so a
      // template-expanded step's keys are checked too. Same non-breaking posture as the
      // workflow-level check (issue #144).
      warnings.push(
        ...findUnknownKeys(step, KNOWN_STEP_KEYS, {
          scope: 'step',
          code: 'UNKNOWN_STEP_KEY',
          step: stepName,
          positionOf: (key) => sourceMap.posOf(['steps', stepName, key]),
        }),
      );

      // issue #220 §4c PR ordering interlock: `$settlement` is reserved NOW (PR-1) even though the
      // namespace it names is not minted until a later PR — else the inter-PR gap could register a
      // `$settlement`-named step that becomes a load-refused fossil the instant the mint ships.
      if (stepName === 'run' || stepName === 'context' || stepName === '$settlement') {
        errors.push(`Step name '${stepName}' is reserved and cannot be used as a step identifier`);
      }

      // Reject integer-like step names: JS object iteration reorders integer-like keys ahead
      // of insertion order, which would silently break the declaration-order guarantees the
      // eligibility loops and finalizer drain rely on (both iterate via Object.entries).
      if (/^\d+$/.test(stepName)) {
        errors.push(
          `Step name '${stepName}' is invalid: integer-like names reorder under JS object ` +
            `iteration and would break declaration-order execution. Use a non-numeric name.`,
        );
      }

      const REQUIRED_STEP = ['description', 'execution'];
      for (const field of REQUIRED_STEP) {
        if (!(field in step)) {
          errors.push(
            withStepLine(stepName, `Step '${stepName}': missing required field '${field}'`),
          );
        }
      }

      if ('execution' in step && !VALID_EXECUTIONS.has(step['execution'] as string)) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': invalid execution value '${String(step['execution'])}'; must be 'auto', 'agent', 'guard', or 'finalizer'`,
          ),
        );
      }

      // Finalizer step constraints (a workflow-level try/catch/finally). handler-only in v1.
      if (step['execution'] === 'finalizer') {
        const prohibited = [
          'depends_on',
          'trigger_rule',
          'abort_unless',
          'abort_message',
          'output_schema',
          'agent_profile',
          'tools',
          'uses_service',
          'service_method',
          'operation',
          'input_map',
          'when',
          'retry',
        ];
        for (const field of prohibited) {
          if (step[field] !== undefined) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': '${field}' is not valid on execution: finalizer steps`,
              ),
            );
          }
        }
        // A finalizer must not gate — reject any human-gate trust level.
        if (step['trust'] !== undefined && step['trust'] !== 'auto') {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'trust: ${String(step['trust'])}' is not valid on execution: finalizer steps (a finalizer must not gate)`,
            ),
          );
        }
        // v1 is handler-only.
        if (step['handler'] === undefined) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': execution: finalizer requires 'handler' (handler-only in v1)`,
            ),
          );
        }
        // on_outcome is required, non-empty, every value in the FinalizerTrigger enum.
        const rawOutcome = step['on_outcome'];
        if (rawOutcome === undefined) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': execution: finalizer requires 'on_outcome'`,
            ),
          );
        } else {
          const outcomes = Array.isArray(rawOutcome) ? rawOutcome : [rawOutcome];
          if (outcomes.length === 0) {
            errors.push(
              withStepLine(stepName, `Step '${stepName}': 'on_outcome' must not be empty`),
            );
          }
          for (const o of outcomes) {
            if (typeof o !== 'string' || !VALID_FINALIZER_TRIGGERS.has(o)) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': invalid on_outcome value '${String(o)}'; must be one of ${[...VALID_FINALIZER_TRIGGERS].join(', ')}`,
                ),
              );
            }
          }
        }
      }

      // on_outcome is only valid on execution: finalizer steps.
      if (step['on_outcome'] !== undefined && step['execution'] !== 'finalizer') {
        errors.push(
          // Consumer: settlement.ts:145 (`finalizerTriggers`) — it is read only when selecting
          // which finalizers a run's outcome should fire.
          withKeyLine(
            stepName,
            'on_outcome',
            `Step '${stepName}': 'on_outcome' is only valid on execution: finalizer steps — it ` +
              'selects which finalizers run for a given outcome, and only finalizers are selected ' +
              'that way, so here it would decide nothing. Move it to the finalizer that should ' +
              'react to the outcome, or remove it.',
          ),
        );
      }

      // Guard step constraints.
      if (step['execution'] === 'guard') {
        const prohibited = [
          'uses_service',
          'handler',
          'input_schema',
          'output_schema',
          'trust',
          'agent_profile',
          'trigger_rule',
          'timeout_seconds',
          'service_method',
          'operation',
          'input_map',
          'tools',
        ];
        for (const field of prohibited) {
          if (step[field] !== undefined) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': '${field}' is not valid on execution: guard steps`,
              ),
            );
          }
        }
        if (step['abort_unless'] === undefined) {
          errors.push(
            withStepLine(stepName, `Step '${stepName}': execution: guard requires 'abort_unless'`),
          );
        }
        // issue #369: `preconditions` gets its OWN error rather than joining `prohibited` above,
        // because the generic message ("'x' is not valid on execution: guard steps") would not say
        // the thing that matters — this field was ACCEPTED and INERT before this check existed, so
        // an author who wrote one has a workflow that looks guarded and never was. The generic
        // list's own message style is issue #366's territory; the other twelve are left alone.
        //
        // The claim "never evaluates it there" rests on `checkPreconditions` having exactly one
        // engine call site (execution-loop.ts:1380, inside `executeStep`), which `executeGuardStep`
        // never reaches. A test pins that count so a second call site reds this message.
        if (step['preconditions'] !== undefined) {
          errors.push(
            withKeyLine(
              stepName,
              'preconditions',
              `Step '${stepName}': 'preconditions' is not valid on execution: guard steps — the ` +
                `engine never evaluates it there (a guard's execution evaluates only 'abort_unless'), ` +
                `so the run would LOOK guarded while the declared check never ran. Move the condition ` +
                `into 'abort_unless'. Whether guards gain a live condition surface is an open design ` +
                `question (issue #366) — if admitted later, existing workflows are unaffected.`,
            ),
          );
        }
      }

      // abort_unless and abort_message are only valid on execution: guard steps.
      if (step['abort_unless'] !== undefined && step['execution'] !== 'guard') {
        errors.push(
          // Consumer: execution-loop.ts:4828 — the condition list a guard evaluates before the
          // run is allowed to continue.
          withKeyLine(
            stepName,
            'abort_unless',
            `Step '${stepName}': 'abort_unless' is only valid on execution: guard steps — it is ` +
              'the condition list a guard evaluates before letting the run continue, and only ' +
              'guard steps are evaluated that way, so here it would gate nothing. Put the check ' +
              'on a guard step, or remove it.',
          ),
        );
      }
      if (step['abort_message'] !== undefined && step['execution'] !== 'guard') {
        errors.push(
          // Consumer: execution-loop.ts:4943 — the text reported when a guard aborts the run.
          // The clause is about READERSHIP, not about who aborts: `handler_abort` and
          // `gate_expiry_abort` are seal arms too (types/run-record.ts:603-617), so "only a guard
          // aborts" would be false. What is true is that every reader of this key is a guard path.
          withKeyLine(
            stepName,
            'abort_message',
            `Step '${stepName}': 'abort_message' is only valid on execution: guard steps — it is ` +
              'the text reported when a guard aborts the run, and nothing but a guard reads it, ' +
              'so here it would never be read. Move it to the guard that performs the abort, or ' +
              'remove it.',
          ),
        );
      }

      // agent_profile is only valid on agent steps.
      if ('agent_profile' in step && step['execution'] !== 'agent') {
        errors.push(
          // Consumer: run-agent.ts:584 — resolved into the model prompt for the step.
          withKeyLine(
            stepName,
            'agent_profile',
            `Step '${stepName}': 'agent_profile' is only valid on execution: agent steps — its ` +
              'content is resolved into the model prompt, and only an agent step makes a model ' +
              'request, so here it would reach no model. Move it to the agent step whose prompt ' +
              'it should shape, or remove it.',
          ),
        );
      }

      // llm_timeout_seconds (issue #401) is only valid on agent steps — no other execution kind
      // makes a model request, so the key would be silently inert anywhere else. One `!== 'agent'`
      // check covers auto/guard/finalizer.
      if (step['llm_timeout_seconds'] !== undefined && step['execution'] !== 'agent') {
        errors.push(
          // Consumer: run-agent.ts:501-507 — the per-step clock resolution, which is the
          // per-attempt bound on the step's model request. The range names the resolution rather
          // than each read: :501 and :507 read the KEY, :503 reads the CLI flag it overrides.
          withKeyLine(
            stepName,
            'llm_timeout_seconds',
            `Step '${stepName}': 'llm_timeout_seconds' is only valid on execution: agent steps — ` +
              'it bounds one model request, and no other kind makes one, so here it would bound ' +
              'nothing. Move it to the agent step whose request it should bound, or remove it. ' +
              "An auto step's dispatch is bounded by 'timeout_seconds', and a " +
              "finalizer's handler by its own 'timeout_seconds'.",
          ),
        );
      }
      // ...and when present it must be a positive integer (the same convention as
      // retry.total_timeout_seconds and gate.timeout_seconds).
      if (
        step['llm_timeout_seconds'] !== undefined &&
        (!Number.isInteger(step['llm_timeout_seconds']) ||
          (step['llm_timeout_seconds'] as number) <= 0)
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'llm_timeout_seconds' must be a positive integer`,
          ),
        );
      }

      // timeout_seconds is NOT valid on an agent step (issue #402). Nothing enforces it there:
      // `shouldEnforceTimeout` is `execution === 'auto'`, and agent dispatch is never wrapped in
      // `withTimeout` at all. The key is now inert as well as unenforced — issue #412 deleted the
      // `expected_timeout` display that used to render it into the NextAction, which is what made
      // it actively misleading rather than merely useless. The error stays: an author who writes a
      // bound should be told it does nothing, not left to find out. The message names both bounds
      // that DO exist, scoped to realm's own drive (an externally driven step gets neither), on
      // the RETRY_INERT_NON_AUTO precedent below.
      //
      // `=== 'agent'` EXACTLY, never `!== 'auto'`: finalizers consume this key twice — the drain
      // lease (execution-loop.ts:5226) and the handler's own bound (:5030) — and guards already
      // reject it in the prohibited-fields list above.
      if (step['timeout_seconds'] !== undefined && step['execution'] === 'agent') {
        errors.push(
          withKeyLine(
            stepName,
            'timeout_seconds',
            `Step '${stepName}': 'timeout_seconds' is not valid on execution: agent steps — ` +
              'the engine never enforces it there (agent dispatch is never wrapped in a timeout), ' +
              'so the step would LOOK time-bounded while nothing enforced the bound. ' +
              "In realm's own drive the model request is bounded by 'llm_timeout_seconds' " +
              "(or --llm-timeout) and tool calls by 'tool_timeout'.",
          ),
        );
      }

      // idempotent (issue #101 Phase 2) is only valid on execution: auto steps — the reliably
      // time-boundable, deadline-carrying class. It is inert (no concrete deadline is ever written)
      // on agent/guard/finalizer, so it is rejected there rather than silently ignored.
      if (step['idempotent'] !== undefined && step['execution'] !== 'auto') {
        errors.push(
          // Consumers: execution-loop.ts:2526 (the `willRetry` conjunct gating `retry.on_timeout`;
          // the :2115 advisory mirrors the rule for loader-bypassing definitions and, by its own
          // header, never gates) and reclaim.ts:73 (reclaim eligibility) — both act on auto
          // dispatch.
          withKeyLine(
            stepName,
            'idempotent',
            `Step '${stepName}': 'idempotent' is only valid on execution: auto steps — it gates ` +
              "'retry.on_timeout' and reclaim eligibility, and both act on auto dispatch, so here " +
              'it would gate nothing. Remove it, or move the work to an auto step if you need ' +
              'either.',
          ),
        );
      }
      // WARN (do not reject): an idempotent auto step in a finalizer-bearing workflow gets
      // `deadline: null` (issue #101), so the RECLAIM function is inert — `realm run reclaim --all`
      // can never select it. The author should know it stays per-step-manual-reclaim-only.
      //
      // Issue #140 C5 (variant-aware reword): `idempotent` now has a SECOND function — gating
      // `retry.on_timeout` — and that GATE function is live in every workflow, finalizer-bearing or
      // not (shouldEnforceTimeout has no finalizer conjunct). A single unconditional message would
      // either keep a falsehood (claiming idempotent is wholly inert when on_timeout is ALSO
      // declared) or gratuitously mention a gate the author never declared (idempotent-alone case)
      // — so the message is keyed on `step.retry?.on_timeout`, pinned by both-variant loader tests.
      if (step['idempotent'] === true && step['execution'] === 'auto' && hasFinalizerStep) {
        const stepRetry =
          typeof step['retry'] === 'object' && step['retry'] !== null
            ? (step['retry'] as Record<string, unknown>)
            : undefined;
        const onTimeoutDeclared = stepRetry?.['on_timeout'] === true;
        warnings.push({
          code: 'IDEMPOTENT_INERT_IN_FINALIZER',
          severity: resolveSeverity('IDEMPOTENT_INERT_IN_FINALIZER'),
          scope: 'step',
          step: stepName,
          message:
            `Step '${stepName}': 'idempotent: true' cannot enable auto-reclaim in a finalizer-bearing ` +
            `workflow (its claim carries no deadline, so 'realm run reclaim --all' can never select ` +
            `it). Recover it with 'realm run reclaim <run-id> --step ${stepName} --force'.` +
            (onTimeoutDeclared
              ? ` Its 'retry.on_timeout' gate role is unaffected — timeout retries remain active.`
              : ''),
        });
      }

      // output_schema is only valid on execution: agent steps.
      if (step['output_schema'] !== undefined && step['execution'] !== 'agent') {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'output_schema' is only valid on execution: agent steps`,
          ),
        );
      }

      // issue #236 (L0 prevention layer): structured_output is only valid on execution: agent
      // steps (mirrors output_schema's rule above), and its only legal value is the literal
      // 'strict'. On an opted-in step, Phase A REJECTS an ineligible verdict at load time — the
      // API provably rejects some legal schemas and silently weakens others, so authoring never
      // ships a schema the gate already knows is unsafe. Caveats are NOT rejected (informational
      // only, surfaced by validate's nudge — Deliverable 7); this loader block only ever REJECTS.
      if (step['structured_output'] !== undefined) {
        if (step['execution'] !== 'agent') {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'structured_output' is only valid on execution: agent steps`,
            ),
          );
        } else if (step['structured_output'] !== 'strict') {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'structured_output' must be the literal string 'strict' (got ${JSON.stringify(step['structured_output'])})`,
            ),
          );
        } else {
          const verdict = assessStructuredOutputEligibility({
            ...(step['output_schema'] !== undefined
              ? { output_schema: step['output_schema'] as JsonSchema }
              : {}),
            ...(step['input_schema'] !== undefined
              ? { input_schema: step['input_schema'] as JsonSchema }
              : {}),
            ...(step['tools'] !== undefined ? { tools: step['tools'] as string[] } : {}),
          });
          if (verdict.verdict === 'ineligible') {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'structured_output: strict' is not eligible for this step's ` +
                  `schema — ${renderIneligibleMessage(verdict.reasons)}`,
              ),
            );
          }
        }
      }

      // issue #220 (PR-2): validation_exhaustion is only valid on execution: agent steps — the
      // countable rejection set (VALIDATION_INPUT_SCHEMA/VALIDATION_OUTPUT_SCHEMA) is agent-only by
      // construction (execution-loop.ts's countRejection). Full rule table: `mode` value validated
      // (REFUSE on an unrecognized value — unvalidatable posture, fail-closed); `mode: 'default'`
      // requires `default_output` (REFUSE — nothing to substitute) which in turn requires the step's
      // own `output_schema` (REFUSE — B5, an unvalidatable default) against which `default_output` is
      // then AJV-proven AT LOAD TIME (REFUSE — B10, reusing the runtime validator so load-time and
      // runtime verdicts can never diverge); `default_output` present without `mode: 'default'` WARNS
      // as dead config (never rejects — it's simply inert); an unknown sub-key WARNS.
      if (step['validation_exhaustion'] !== undefined) {
        if (step['execution'] !== 'agent') {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'validation_exhaustion' is only valid on execution: agent steps`,
            ),
          );
        } else if (
          typeof step['validation_exhaustion'] !== 'object' ||
          step['validation_exhaustion'] === null
        ) {
          errors.push(
            withStepLine(stepName, `Step '${stepName}': 'validation_exhaustion' must be an object`),
          );
        } else {
          const exhaustionBlock = step['validation_exhaustion'] as Record<string, unknown>;

          // WARN (do not reject) on an unknown validation_exhaustion sub-key — the retry-block-style
          // pattern (issue #140's UNKNOWN_RETRY_KEY), its OWN code (issue #220 PR-2 mints
          // UNKNOWN_VALIDATION_EXHAUSTION_KEY, replacing PR-1's UNKNOWN_STEP_KEY noun-override —
          // closes the #170-flip incoherence against the structurally identical retry-key family).
          warnings.push(
            ...findUnknownKeys(exhaustionBlock, KNOWN_VALIDATION_EXHAUSTION_KEYS, {
              scope: 'step',
              code: 'UNKNOWN_VALIDATION_EXHAUSTION_KEY',
              step: stepName,
              noun: 'validation_exhaustion',
              positionOf: (key) =>
                sourceMap.posOf(['steps', stepName, 'validation_exhaustion', key]),
            }),
          );

          if (
            'threshold' in exhaustionBlock &&
            (!Number.isInteger(exhaustionBlock['threshold']) ||
              (exhaustionBlock['threshold'] as number) < 1)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'validation_exhaustion.threshold' must be a positive integer ` +
                  `(1 is legal — it disables in-drive schema-repair, since the first rejection ` +
                  `already meets it)`,
              ),
            );
          }

          const modeValue = exhaustionBlock['mode'];
          if (modeValue !== undefined && modeValue !== 'fail' && modeValue !== 'default') {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'validation_exhaustion.mode' must be 'fail' or 'default' ` +
                  `(got: ${JSON.stringify(modeValue)})`,
              ),
            );
          }

          const hasDefaultOutput = 'default_output' in exhaustionBlock;
          if (modeValue === 'default') {
            if (!hasDefaultOutput) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': 'validation_exhaustion.mode: default' requires ` +
                    `'default_output' (nothing to substitute on exhaustion)`,
                ),
              );
            } else if (step['output_schema'] === undefined) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': 'validation_exhaustion.default_output' requires the step to ` +
                    `declare 'output_schema' (an undeclared schema makes the default unvalidatable)`,
                ),
              );
            } else {
              // B10 — load-time AJV proof: REUSE the runtime validator so the load-time verdict can
              // never diverge from the runtime verdict for the exact same (default_output,
              // output_schema) pair. This is the loader's first load-time Ajv compile of an
              // output_schema (today output_schema is only compiled at runtime), so the catch below
              // legitimately sees TWO different populations: a VALIDATION_OUTPUT_SCHEMA
              // WorkflowError (default_output fails the schema) and a raw Ajv schema-compilation
              // Error (a structurally malformed output_schema) — both fail-closed to a load refusal,
              // but they carry their detail DIFFERENTLY: a WorkflowError has `.details.errors`; a raw
              // Error has NO `.details` at all (reading `.details.errors` on it throws a TypeError
              // that would escape the loader mid-walk — verified empirically). Discriminate.
              try {
                validateOutputSchema(
                  exhaustionBlock['default_output'] as Record<string, unknown>,
                  step['output_schema'] as JsonSchema,
                  stepName,
                );
              } catch (err) {
                const detail =
                  err instanceof WorkflowError
                    ? JSON.stringify(err.details['errors'])
                    : err instanceof Error
                      ? err.message
                      : String(err);
                errors.push(
                  withStepLine(
                    stepName,
                    `Step '${stepName}': 'validation_exhaustion.default_output' does not validate ` +
                      `against the step's own 'output_schema': ${detail}`,
                  ),
                );
              }
            }
          } else if (hasDefaultOutput) {
            // default_output present without mode: 'default' (mode: 'fail' or absent) — inert, not
            // an error: WARN as dead config rather than silently ignoring it.
            warnings.push({
              code: 'DEAD_VALIDATION_EXHAUSTION_CONFIG',
              severity: resolveSeverity('DEAD_VALIDATION_EXHAUSTION_CONFIG'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'validation_exhaustion.default_output' is ignored without ` +
                `'mode: default' — set 'validation_exhaustion.mode: default' to enable it, or ` +
                `remove 'default_output'.`,
            });
          }
        }
      }

      // WARN (do not reject): an agent step declaring BOTH input_schema and output_schema has its
      // submitted output validated against BOTH (execution-loop.ts validateInputSchema AND
      // validateOutputSchema) — a divergence between the two degrades to a confusing recoverable
      // VALIDATION_*_SCHEMA error rather than a clean failure. Detection/warn only; no schema change.
      if (
        step['execution'] === 'agent' &&
        step['input_schema'] !== undefined &&
        step['output_schema'] !== undefined
      ) {
        warnings.push({
          code: 'DUAL_SCHEMA_DECLARED',
          severity: resolveSeverity('DUAL_SCHEMA_DECLARED'),
          scope: 'step',
          step: stepName,
          message:
            `Step '${stepName}': declares both input_schema and output_schema; the agent's submitted ` +
            `output is validated against both — prefer one to avoid divergence.`,
        });
      }

      // trace_schema is only valid on execution: agent steps.
      if (step['trace_schema'] !== undefined && step['execution'] !== 'agent') {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'trace_schema' is only valid on execution: agent steps`,
          ),
        );
      }

      // trace_validation_mode is only valid on execution: agent steps.
      if (step['trace_validation_mode'] !== undefined && step['execution'] !== 'agent') {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'trace_validation_mode' is only valid on execution: agent steps`,
          ),
        );
      }

      // trace_validation_mode must be 'warn' or 'enforce' when provided.
      if (
        step['trace_validation_mode'] !== undefined &&
        step['trace_validation_mode'] !== 'warn' &&
        step['trace_validation_mode'] !== 'enforce'
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': invalid trace_validation_mode '${String(step['trace_validation_mode'])}'; must be 'warn' or 'enforce'`,
          ),
        );
      }

      // issue #291 (authorable gate timeout — the FIRST validation the `gate:` block has ever had):
      // the E2 positive-integer checks on timeout_seconds/reminder_seconds/reminder_max, the
      // on_expiry enum, default_choice's required-iff + choice-set validation, and the dead-config
      // warn cells. Runs regardless of `trust` (a `gate:` block with no gate trust is already inert
      // — no separate rejection needed; the existing render/mint paths never read it without a
      // trust value).
      if (step['gate'] !== undefined) {
        if (typeof step['gate'] !== 'object' || step['gate'] === null) {
          errors.push(withStepLine(stepName, `Step '${stepName}': 'gate' must be an object`));
        } else {
          const gate = step['gate'] as Record<string, unknown>;

          // WARN (do not reject) on an unknown gate-block key — same non-breaking posture as
          // retry/validation_exhaustion (issues #140/#220).
          warnings.push(
            ...findUnknownKeys(gate, KNOWN_GATE_KEYS, {
              scope: 'step',
              code: 'UNKNOWN_GATE_KEY',
              step: stepName,
              noun: 'gate',
              positionOf: (key) => sourceMap.posOf(['steps', stepName, 'gate', key]),
            }),
          );

          // E2: timeout_seconds/reminder_seconds/reminder_max must each be a positive integer
          // (yaml-loader :1164-1174 precedent — the SAME convention as retry.total_timeout_seconds).
          if (
            'timeout_seconds' in gate &&
            (!Number.isInteger(gate['timeout_seconds']) || (gate['timeout_seconds'] as number) <= 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'gate.timeout_seconds' must be a positive integer`,
              ),
            );
          }
          if (
            'reminder_seconds' in gate &&
            (!Number.isInteger(gate['reminder_seconds']) ||
              (gate['reminder_seconds'] as number) <= 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'gate.reminder_seconds' must be a positive integer`,
              ),
            );
          }
          if (
            'reminder_max' in gate &&
            (!Number.isInteger(gate['reminder_max']) || (gate['reminder_max'] as number) <= 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'gate.reminder_max' must be a positive integer`,
              ),
            );
          }

          // on_expiry must be 'settle_default' or 'abort' when provided.
          const onExpiry = gate['on_expiry'];
          if (onExpiry !== undefined && onExpiry !== 'settle_default' && onExpiry !== 'abort') {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'gate.on_expiry' must be 'settle_default' or 'abort' (got: ${JSON.stringify(onExpiry)})`,
              ),
            );
          }

          // default_choice: REQUIRED iff on_expiry === 'settle_default' (E2-style hard error,
          // mirroring validation_exhaustion.mode:'default' requiring default_output); validated
          // against the step's own EFFECTIVE STATIC choice set — the EXACT same three-source
          // derivation the engine mints PendingGate.choices from (execution-loop.ts's gate-open
          // site: gate.choices ?? input_schema.properties.choice.enum ?? ['approve','reject']) —
          // so a load-time-legal default_choice can NEVER fail at enactment time.
          const hasDefaultChoice = 'default_choice' in gate;
          if (onExpiry === 'settle_default') {
            if (!hasDefaultChoice) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': 'gate.on_expiry: settle_default' requires 'gate.default_choice' ` +
                    `(nothing to resolve the gate with on expiry)`,
                ),
              );
            } else {
              const choicesRaw =
                gate['choices'] ??
                (step['input_schema'] as JsonSchema | undefined)?.properties?.['choice']?.enum;
              const effectiveChoices = Array.isArray(choicesRaw)
                ? (choicesRaw as string[])
                : ['approve', 'reject'];
              if (!effectiveChoices.includes(gate['default_choice'] as string)) {
                errors.push(
                  withStepLine(
                    stepName,
                    `Step '${stepName}': 'gate.default_choice' (${JSON.stringify(gate['default_choice'])}) ` +
                      `is not one of the step's effective choices: ${effectiveChoices.join(', ')}`,
                  ),
                );
              }
            }
          } else if (hasDefaultChoice) {
            // default_choice with on_expiry:'abort' or with no on_expiry at all — inert, not an
            // error: WARN as dead config (the #220 DEAD_VALIDATION_EXHAUSTION_CONFIG precedent).
            warnings.push({
              code: 'DEAD_GATE_CONFIG',
              severity: resolveSeverity('DEAD_GATE_CONFIG'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'gate.default_choice' is ignored without ` +
                `'gate.on_expiry: settle_default' — set it, or remove 'gate.default_choice'.`,
            });
          }

          // Dead config: on_expiry declared but no timeout_seconds — nothing will ever trigger the
          // enforce clock, so the declared disposition can never enact.
          if (onExpiry !== undefined && gate['timeout_seconds'] === undefined) {
            warnings.push({
              code: 'DEAD_GATE_CONFIG',
              severity: resolveSeverity('DEAD_GATE_CONFIG'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'gate.on_expiry' is ignored without 'gate.timeout_seconds' — ` +
                `set a timeout, or remove 'gate.on_expiry'.`,
            });
          }

          // Dead notification ([F-A2-5]): reminder_seconds >= timeout_seconds means the FIRST
          // reminder occurrence would never fire before the enforce clock expires.
          if (
            typeof gate['reminder_seconds'] === 'number' &&
            typeof gate['timeout_seconds'] === 'number' &&
            gate['reminder_seconds'] >= gate['timeout_seconds']
          ) {
            warnings.push({
              code: 'DEAD_GATE_CONFIG',
              severity: resolveSeverity('DEAD_GATE_CONFIG'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'gate.reminder_seconds' (${String(gate['reminder_seconds'])}) ` +
                `>= 'gate.timeout_seconds' (${String(gate['timeout_seconds'])}) — the first reminder ` +
                `would never fire before the gate expires.`,
            });
          }
        }
      }

      if ('uses_service' in step && typeof step['uses_service'] === 'string') {
        const services = doc['services'];
        if (
          typeof services !== 'object' ||
          services === null ||
          !(step['uses_service'] in (services as Record<string, unknown>))
        ) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': uses_service '${step['uses_service']}' is not defined in 'services'`,
            ),
          );
        }
      }

      // Validate retry: backoff must be a recognised value when present.
      if (step['retry'] !== undefined) {
        if (typeof step['retry'] !== 'object' || step['retry'] === null) {
          errors.push(withStepLine(stepName, `Step '${stepName}': 'retry' must be an object`));
        } else {
          const retry = step['retry'] as Record<string, unknown>;

          // WARN (do not reject) on an unknown retry-block key — same non-breaking posture as the
          // step/workflow-level checks (issue #140). Noun overridden to 'retry' (not 'step') since
          // this is a nested block, not the step itself.
          warnings.push(
            ...findUnknownKeys(retry, KNOWN_RETRY_KEYS, {
              scope: 'step',
              code: 'UNKNOWN_RETRY_KEY',
              step: stepName,
              noun: 'retry',
              positionOf: (key) => sourceMap.posOf(['steps', stepName, 'retry', key]),
            }),
          );

          if (
            'backoff' in retry &&
            retry['backoff'] !== 'fixed' &&
            retry['backoff'] !== 'linear' &&
            retry['backoff'] !== 'exponential'
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.backoff' must be 'fixed', 'linear', or 'exponential'`,
              ),
            );
          }
          if (
            'max_attempts' in retry &&
            (!Number.isInteger(retry['max_attempts']) || (retry['max_attempts'] as number) < 1)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.max_attempts' must be a positive integer`,
              ),
            );
          }
          if (
            'base_delay_ms' in retry &&
            (typeof retry['base_delay_ms'] !== 'number' || (retry['base_delay_ms'] as number) < 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.base_delay_ms' must be a non-negative number`,
              ),
            );
          }
          if (
            'max_delay_ms' in retry &&
            (typeof retry['max_delay_ms'] !== 'number' || (retry['max_delay_ms'] as number) < 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.max_delay_ms' must be a non-negative number`,
              ),
            );
          }

          // --- issue #140: on_timeout / total_timeout_seconds --------------------------------

          // E3: on_timeout must be a boolean (kills the 'on_timeout: "true"' silent-inert case).
          if ('on_timeout' in retry && typeof retry['on_timeout'] !== 'boolean') {
            errors.push(
              withStepLine(stepName, `Step '${stepName}': 'retry.on_timeout' must be a boolean`),
            );
          }

          // E2: total_timeout_seconds must be a positive integer — same convention as
          // timeout_seconds (0 is rejected here at load; a hand-built definition bypassing the
          // loader may still set 0 and have the engine's resolveCapMs honor it as a present cap).
          if (
            'total_timeout_seconds' in retry &&
            (!Number.isInteger(retry['total_timeout_seconds']) ||
              (retry['total_timeout_seconds'] as number) <= 0)
          ) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.total_timeout_seconds' must be a positive integer`,
              ),
            );
          }

          // E1: on_timeout: true requires idempotent: true — declared, never inferred. Strict
          // `=== true` on both loci, provably matching the engine's own conjunct.
          if (retry['on_timeout'] === true && step['idempotent'] !== true) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'retry.on_timeout: true' requires 'idempotent: true' declared ` +
                  `on the step — a timeout-retry can run concurrently with the still-in-flight ` +
                  `original attempt, so the step must explicitly attest that any partial prior ` +
                  `application is harmless to re-apply. Declare 'idempotent: true' or remove ` +
                  `'on_timeout'.`,
              ),
            );
          }

          // W5 (CAP-ONLY advisory — the on_timeout half of this is already an E1 hard error, so
          // it never reaches here as a warning): the total-time cap only bounds `execution: 'auto'`
          // dispatch — inert on any other step type that legally declares `retry:` today.
          if (step['execution'] !== 'auto' && retry['total_timeout_seconds'] !== undefined) {
            warnings.push({
              code: 'TOTAL_TIMEOUT_NON_AUTO',
              severity: resolveSeverity('TOTAL_TIMEOUT_NON_AUTO'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'retry.total_timeout_seconds' is inert on execution: ` +
                `'${String(step['execution'])}' steps — the cap only bounds 'execution: auto' ` +
                `dispatch, which is the only dispatch ever wrapped in a timeout.`,
            });
          }

          // issue #218 (extends the W5 family): the BARE-KEYS advisory — no explicit
          // total_timeout_seconds (that shape is W5's, above), but retry: is present on a step the
          // built-in dispatch path never wraps in a throwing retry loop at all. Complementary to
          // W5's own `!== undefined` conjunct on the SAME `execution !== 'auto'` gate, so for any
          // non-auto retry block that reaches this point (finalizer+retry and invalid-cap shapes
          // already hard-errored above; on_timeout: true already hard-errored via E1 unless
          // idempotent is also declared, which is itself rejected by the pre-existing
          // idempotent-non-auto check) exactly ONE of {W5, RETRY_INERT_NON_AUTO} ever fires — never
          // both, never neither.
          if (step['execution'] !== 'auto' && retry['total_timeout_seconds'] === undefined) {
            const isAgent = step['execution'] === 'agent';
            const message = isAgent
              ? `Step '${stepName}': 'retry' is inert on execution: 'agent' steps — the built-in ` +
                `dispatch path never throws for agent steps, so this block can never mint a second ` +
                `attempt here (for schema-repair budgets, use the CLI drive's '--schema-retries' ` +
                `flag instead). An embedder-supplied throwing dispatcher may still consume this ` +
                `config — a deliberate public-API capability, not an invalid one.`
              : `Step '${stepName}': 'retry' is inert on execution: '${String(step['execution'])}' ` +
                `steps — the built-in dispatch path never throws for these steps, so this block can ` +
                `never mint a second attempt here. An embedder-supplied throwing dispatcher may ` +
                `still consume this config — a deliberate public-API capability, not an invalid one.`;
            warnings.push({
              code: 'RETRY_INERT_NON_AUTO',
              severity: resolveSeverity('RETRY_INERT_NON_AUTO'),
              scope: 'step',
              step: stepName,
              message,
            });
          }

          // W1: on_timeout with an effective max_attempts of 1 (explicit OR absent, since the
          // loader admits an absent max_attempts and the engine then defaults it to 1) — there is
          // no second attempt for the opt-in to retry into.
          const effectiveMaxAttempts =
            typeof retry['max_attempts'] === 'number' ? retry['max_attempts'] : 1;
          if (retry['on_timeout'] === true && effectiveMaxAttempts === 1) {
            warnings.push({
              code: 'ON_TIMEOUT_SINGLE_ATTEMPT',
              severity: resolveSeverity('ON_TIMEOUT_SINGLE_ATTEMPT'),
              scope: 'step',
              step: stepName,
              message:
                `Step '${stepName}': 'retry.on_timeout: true' has no effect with an effective ` +
                `'max_attempts' of 1 — there is no second attempt to retry into.`,
            });
          }

          // W2: the cap can never cover even a single full-length attempt — (a) an EXPLICIT cap
          // below an EXPLICIT timeout_seconds, or (b) on_timeout: true with a cap at-or-below the
          // effective per-attempt timeout (retry-defeating: the opt-in can never yield a viable
          // second attempt). Both conditions require an EXPLICIT total_timeout_seconds — the
          // AMENDED default cap (the worst-case schedule) is, by construction, never below a
          // single attempt for max_attempts ≥ 2, so this never fires on the bare 3600s-default
          // population.
          const explicitCapSeconds =
            typeof retry['total_timeout_seconds'] === 'number'
              ? retry['total_timeout_seconds']
              : undefined;
          if (explicitCapSeconds !== undefined) {
            const explicitTimeoutSeconds =
              typeof step['timeout_seconds'] === 'number' ? step['timeout_seconds'] : undefined;
            const effectivePerAttemptSeconds =
              explicitTimeoutSeconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS;
            const belowExplicitAttempt =
              explicitTimeoutSeconds !== undefined && explicitCapSeconds < explicitTimeoutSeconds;
            const capTooTightForRetry =
              retry['on_timeout'] === true && explicitCapSeconds <= effectivePerAttemptSeconds;
            if (belowExplicitAttempt || capTooTightForRetry) {
              warnings.push({
                code: 'TOTAL_TIMEOUT_BELOW_ATTEMPT',
                severity: resolveSeverity('TOTAL_TIMEOUT_BELOW_ATTEMPT'),
                scope: 'step',
                step: stepName,
                message:
                  `Step '${stepName}': 'retry.total_timeout_seconds: ${explicitCapSeconds}' is at ` +
                  `or below its own effective per-attempt timeout (${effectivePerAttemptSeconds}s) ` +
                  `— the cap can never cover a single full-length attempt, so a retry can never ` +
                  `occur before the cap fires.`,
              });
            }
          }
        }
      }

      if (
        'service_method' in step &&
        !VALID_SERVICE_METHODS.has(step['service_method'] as string)
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': invalid service_method '${String(step['service_method'])}'; must be 'fetch', 'create', 'update', or 'delete'`,
          ),
        );
      }

      // Validate input_map: only valid on execution: auto steps (both uses_service and handler).
      if (step['input_map'] !== undefined) {
        if (step['execution'] !== 'auto') {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'input_map' is only valid on execution: auto steps`,
            ),
          );
        } else {
          // issue #392: input_map's errors are minted deep inside a recursive walk that knows only
          // its path string, not the step's position. Collected here and suffixed on the way out,
          // so ONE step's error list never mixes positioned and bare messages — a reader seeing
          // "(step at line 12)" on three of five errors would reasonably wonder what is different about
          // the other two, and nothing is.
          const inputMapErrors: string[] = [];
          validateInputMapNode(
            step['input_map'] as Record<string, unknown>,
            `Step '${stepName}': input_map`,
            inputMapErrors,
            0,
          );
          errors.push(...inputMapErrors.map((e) => withStepLine(stepName, e)));
        }
      }

      // Step config may hold any JSON value (scalars, arrays, nested objects). It is passed through
      // opaquely to handlers (context.config) and merged into adapter config for uses_service steps;
      // the adapter's config_schema (below) remains the real validator for uses_service config.

      // Validate step config against adapter config_schema (requires registry).
      if (step['config'] !== undefined && step['uses_service'] !== undefined) {
        const serviceName = step['uses_service'] as string;
        const services = doc['services'] as Record<string, unknown> | undefined;
        const service = services?.[serviceName] as Record<string, unknown> | undefined;
        const adapterName = service?.['adapter'] as string | undefined;
        const adapter = adapterName !== undefined ? registry?.getAdapter(adapterName) : undefined;
        if (adapter !== undefined && adapter.config_schema === undefined) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'config' declared but adapter '${adapterName}' does not declare 'config_schema'`,
            ),
          );
        } else if (adapter?.config_schema !== undefined) {
          const ajv = new Ajv();
          const valid = ajv.validate(adapter.config_schema as object, step['config']);
          if (!valid) {
            const errMessages =
              ajv.errors?.map((e) => e.message ?? '').join('; ') ?? 'unknown error';
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': config validation failed against adapter config_schema: ${errMessages}`,
              ),
            );
          }
        }
      }

      // Validate uses_resources: each listed step ID must exist in the workflow.
      if (step['handler'] !== undefined && registry !== undefined) {
        const handlerName = step['handler'] as string;
        const handler = registry.getHandler(handlerName);
        if (handler !== undefined && handler.uses_resources !== undefined) {
          for (const resourceStepId of handler.uses_resources) {
            if (!(resourceStepId in stepsRaw)) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': handler '${handlerName}' declares uses_resources '${resourceStepId}' ` +
                    `but no step with that ID exists in this workflow`,
                ),
              );
            }
          }
        }
      }

      // Validate trigger_rule.
      if ('trigger_rule' in step) {
        if (!VALID_TRIGGER_RULES.has(step['trigger_rule'] as TriggerRule)) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': invalid trigger_rule '${String(step['trigger_rule'])}'; must be one of ${[...VALID_TRIGGER_RULES].join(', ')}`,
            ),
          );
        }
      }

      // Validate depends_on: must be an array of existing step names.
      if ('depends_on' in step && step['depends_on'] !== undefined) {
        if (!Array.isArray(step['depends_on'])) {
          errors.push(withStepLine(stepName, `Step '${stepName}': 'depends_on' must be an array`));
        } else {
          for (const dep of step['depends_on'] as unknown[]) {
            if (typeof dep !== 'string') {
              errors.push(
                withStepLine(stepName, `Step '${stepName}': depends_on entries must be strings`),
              );
            } else if (dep === stepName) {
              errors.push(
                withStepLine(stepName, `Step '${stepName}': a step cannot depend on itself`),
              );
            } else if (!(dep in stepsRaw)) {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': depends_on references unknown step '${dep}'`,
                ),
              );
            } else if ((stepsRaw[dep] as Record<string, unknown>)['execution'] === 'finalizer') {
              // A domain step depending on a held-out finalizer would deadlock: the finalizer
              // never enters the eligible set, so this step never becomes eligible and the run
              // never seals.
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': depends_on references finalizer step '${dep}' — finalizers ` +
                    `run at the terminal transition and are held out of the DAG; a step cannot depend on one.`,
                ),
              );
            }
          }
        }
      }

      // Validate when: string | string[] of single-comparison/bare-path leaves (implicit AND).
      if ('when' in step && step['when'] !== undefined) {
        const rawWhen = step['when'];
        if (typeof rawWhen === 'string') {
          if (rawWhen.trim() === '') {
            errors.push(
              withStepLine(stepName, `Step '${stepName}': 'when' must be a non-empty string`),
            );
          } else {
            validateConditionLeaf('when', rawWhen, stepName, dependsOn, errors, withStepLine);
          }
        } else if (Array.isArray(rawWhen)) {
          if (rawWhen.length === 0) {
            errors.push(
              withStepLine(stepName, `Step '${stepName}': 'when' array must not be empty`),
            );
          } else {
            for (const leaf of rawWhen) {
              if (typeof leaf !== 'string' || leaf.trim() === '') {
                errors.push(
                  withStepLine(
                    stepName,
                    `Step '${stepName}': 'when' array entries must be non-empty strings`,
                  ),
                );
              } else {
                validateConditionLeaf('when', leaf, stepName, dependsOn, errors, withStepLine);
              }
            }
          }
        } else {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'when' must be a string or an array of strings`,
            ),
          );
        }
      }

      // Validate abort_unless leaf shape (guard steps only; the LEGACY depends_on/run.params
      // reference check is when-only — but issue #220 §4c's `$settlement` one-hop check fires here
      // too, via the hoisted `dependsOn`, SCOPED to `$settlement.`-prefixed paths only).
      if (step['abort_unless'] !== undefined && step['execution'] === 'guard') {
        const rawAbort = step['abort_unless'];
        if (typeof rawAbort === 'string') {
          if (rawAbort.trim() === '') {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': 'abort_unless' must be a non-empty string`,
              ),
            );
          } else {
            validateConditionLeaf(
              'abort_unless',
              rawAbort,
              stepName,
              dependsOn,
              errors,
              withStepLine,
            );
          }
        } else if (Array.isArray(rawAbort)) {
          if (rawAbort.length === 0) {
            errors.push(
              withStepLine(stepName, `Step '${stepName}': 'abort_unless' array must not be empty`),
            );
          } else {
            for (const leaf of rawAbort) {
              if (typeof leaf !== 'string' || leaf.trim() === '') {
                errors.push(
                  withStepLine(
                    stepName,
                    `Step '${stepName}': 'abort_unless' array entries must be non-empty strings`,
                  ),
                );
              } else {
                validateConditionLeaf(
                  'abort_unless',
                  leaf,
                  stepName,
                  dependsOn,
                  errors,
                  withStepLine,
                );
              }
            }
          }
        } else {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'abort_unless' must be a string or an array of strings`,
            ),
          );
        }
      }

      // Validate preconditions leaf shape (each must be a single comparison). Reference check is
      // `$settlement`-scoped only (issue #220 §4c) — a non-`$settlement` precondition has no
      // depends_on/run.params check (unchanged from before this PR).
      if (step['preconditions'] !== undefined) {
        const rawPre = step['preconditions'];
        if (!Array.isArray(rawPre)) {
          errors.push(
            withStepLine(
              stepName,
              `Step '${stepName}': 'preconditions' must be an array of strings`,
            ),
          );
        } else {
          for (const leaf of rawPre) {
            if (typeof leaf !== 'string' || leaf.trim() === '') {
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': 'preconditions' entries must be non-empty strings`,
                ),
              );
            } else {
              validateConditionLeaf(
                'preconditions',
                leaf,
                stepName,
                dependsOn,
                errors,
                withStepLine,
              );
            }
          }
        }
      }

      // issue #362 — REJECT A PROVABLY-DEAD FAILURE CONDITION.
      //
      // `$settlement.<dep>.failed == true` under a trigger rule that structurally excludes a failed
      // `<dep>` can never be true. The trigger gate runs BEFORE the condition gate, and both
      // `all_success` and `none_failed` carry an explicit "no dep in failed_steps" conjunct — so if
      // the rule is satisfied, `<dep>` did not fail, and the condition is false by construction.
      //
      // The author's compensation step therefore never runs. It is not silent at runtime — the run
      // record says `trigger_rule_unsatisfiable` — but it names the RULE and the blocking dep, never
      // the condition the author wrote, so the diagnosis points away from the mistake. This is an
      // authoring-time error precisely because the fix is one word and no legitimate use of the
      // shape exists.
      dead_condition: {
        const rule =
          step['execution'] === 'guard' ? 'all_success' : (step['trigger_rule'] ?? 'all_success');
        // A guard may not declare `trigger_rule` at all (it is a prohibited field), so a guard that
        // declares one must NOT be able to suppress this check by doing so.
        const ruleDeclared = step['execution'] !== 'guard' && step['trigger_rule'] !== undefined;
        if (step['execution'] !== 'guard' && !VALID_TRIGGER_RULES.has(rule as TriggerRule)) {
          break dead_condition; // an invalid rule already has its own error — adding noise helps nobody
        }
        if (rule !== 'all_success' && rule !== 'none_failed') break dead_condition;

        const asLeaves = (v: unknown): string[] =>
          Array.isArray(v)
            ? v.filter((x): x is string => typeof x === 'string')
            : typeof v === 'string'
              ? [v]
              : [];
        const surfaces: Array<{ surface: ConditionSurface; leaves: string[] }> = [
          { surface: 'when', leaves: asLeaves(step['when']) },
          // `abort_unless` is only validated (and only meaningful) on guards; on anything else the
          // loader leaves it alone and the engine never reads it.
          {
            surface: 'abort_unless',
            leaves: step['execution'] === 'guard' ? asLeaves(step['abort_unless']) : [],
          },
          // `preconditions` is collected for EVERY step kind, but it is INERT on a guard: the sole
          // `checkPreconditions` call site is `executeStep` (execution-loop.ts:1380), and a guard
          // goes through `executeGuardStep`, which evaluates only `abort_unless`. That is why the
          // guard arm's consequence below is forked — collapsing it back into one shared string
          // would make the error claim a wedge that cannot happen.
          //
          // Post-#369 a guard declaring `preconditions` is REFUSED outright by the guard block
          // above, so this arm now only ever fires ALONGSIDE that refusal: errors accumulate rather
          // than short-circuit, and the guard block runs first, so both messages reach the author
          // with the prohibition printed above this one. The arm is kept, not deleted — it is what
          // stops the dead-condition message from claiming a wedge that a guard cannot have, and a
          // definition reaching this code by any path other than a fresh YAML load (a
          // store-registered definition, an inline object) is never re-parsed and never sees the
          // prohibition at all.
          { surface: 'preconditions', leaves: asLeaves(step['preconditions']) },
        ];

        for (const { surface, leaves } of surfaces) {
          for (const leaf of leaves) {
            const split = splitComparison(leaf);
            // Two spellings are equally dead: the explicit `== true`, and the BARE PATH, which the
            // engine coerces with `Boolean()`. `preconditions` refuses bare paths anyway.
            const lhsPath =
              split.kind === 'comparison' && split.op === '==' && split.rhsRaw.trim() === 'true'
                ? split.lhsPath
                : split.kind === 'path'
                  ? split.path
                  : undefined;
            if (lhsPath === undefined) continue;
            // EXACTLY three segments. `$settlement.x.failed.deep` is also dead, but for a different
            // reason, so the trigger-rule remedy would be wrong advice there.
            const segments = lhsPath.trim().split('.');
            if (
              segments.length !== 3 ||
              segments[0] !== '$settlement' ||
              segments[2] !== 'failed'
            ) {
              continue;
            }
            const dep = segments[1]!;
            // Without the dep actually being a dependency, the one-hop error fires on its own AND
            // the trigger gate returns true unconditionally for a step with no deps — so the leaf
            // is not dead-by-trigger here and the remedy would be false advice.
            if (!dependsOn.includes(dep)) continue;

            const ruleText = ruleDeclared ? `'${rule}'` : `the default '${rule}'`;
            const guardPrecondition = step['execution'] === 'guard' && surface === 'preconditions';
            const consequence =
              surface === 'when'
                ? `if '${dep}' fails the step is skipped as trigger_rule_unsatisfiable before the condition is evaluated; if '${dep}' succeeds the condition evaluates to false (when_false) — either way the step never runs`
                : surface === 'preconditions'
                  ? guardPrecondition
                    ? // NOT the wedge: an unevaluated condition cannot block anything.
                      `the run behaves identically whether this condition is present or absent`
                    : `the step never settles — the run WEDGES in a blocked envelope`
                  : `the guard aborts the run on every execution`;

            if (step['execution'] === 'guard') {
              // Guards cannot declare a trigger rule, so the trigger-rule remedy is wrong advice
              // here. This is a v1 SCOPE narrowing, not an architectural statement — issue #366
              // carries the design question.
              //
              // The middle clause forks with the consequence: "by the time this is evaluated" is
              // itself false for `preconditions`, which a guard never evaluates at all.
              const cause = guardPrecondition
                ? `and on an execution: guard step it is never evaluated at all: a guard evaluates ` +
                  `only 'abort_unless', so this condition is inert (${consequence})`
                : `a guard runs under ${ruleText} and 'trigger_rule' is not a valid field on ` +
                  `execution: guard steps, so '${dep}' has always succeeded by the time this is ` +
                  `evaluated (${consequence})`;
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': '${surface}' condition "${leaf}" can never be true — ${cause}. ` +
                    `Guards run only when their dependencies succeeded; for work that must happen AFTER a ` +
                    `failure, use an 'execution: finalizer' step (see issue #366 for widening guards).`,
                ),
              );
            } else {
              const remedies = ['all_done', 'one_failed'];
              if (new Set(dependsOn).size === 1) remedies.push('all_failed');
              const tail =
                new Set(dependsOn).size > 1
                  ? ` ('all_failed' fires only if EVERY dependency fails; 'one_success' only if at least one other dependency succeeds.)`
                  : '';
              errors.push(
                withStepLine(
                  stepName,
                  `Step '${stepName}': '${surface}' condition "${leaf}" can never be true — under ` +
                    `${ruleText} trigger rule, '${dep}' can never be in failed_steps when this step is ` +
                    `evaluated (${consequence}). To run this step when '${dep}' fails, set trigger_rule to ` +
                    `one of: ${remedies.join(', ')}.${tail}`,
                ),
              );
            }
          }
        }
      }

      // Validate tools: only valid on execution: agent steps without handler.
      if (
        step['tools'] !== undefined &&
        (step['execution'] !== 'agent' || step['handler'] !== undefined)
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'tools' is only valid on execution: agent steps without 'handler' defined`,
          ),
        );
      }

      // issue #413: `tool_timeout` requires `tools`. It bounds ONE tool call inside the agentic
      // loop (run-agent.ts), and a step with no tools never enters that loop — so the key sits
      // there bounding nothing while its author believes tool calls are capped.
      //
      // An EMPTY list counts as missing, and that is not pedantry: run-agent gates the tools path
      // on `tools.length > 0`, so `tools: []` is exactly as toolless at runtime as no key at all.
      // This one helper is also the shape check's complement further down, which is what makes
      // "exactly one error" true by construction rather than by coincidence.
      //
      // NOT extended to non-array `tools` spellings — that is #391, still open. Under the
      // `!toolsMissing` complement below, a non-array `tools` still lets the shape check fire, so
      // nothing is silently exempted here.
      const toolsMissing =
        step['tools'] === undefined ||
        (Array.isArray(step['tools']) && (step['tools'] as unknown[]).length === 0);
      if (step['tool_timeout'] !== undefined && toolsMissing) {
        errors.push(
          withKeyLine(
            stepName,
            'tool_timeout',
            `Step '${stepName}': 'tool_timeout' requires 'tools' (a declared, non-empty list) — ` +
              'without tool calls there is ' +
              'nothing for it to bound, so the step would carry a bound with nothing to bind. ' +
              "In realm's own drive each tool call is capped at tool_timeout seconds (default " +
              '30); declare at least one tool or remove the key.',
          ),
        );
      }

      // Validate tools: requires input_schema.
      if (step['tools'] !== undefined && step['input_schema'] === undefined) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'tools' requires 'input_schema' to be defined — the agentic loop needs a schema for final output extraction`,
          ),
        );
      }

      // Validate tools: entries must be in server_id:tool_name format.
      if (step['tools'] !== undefined && Array.isArray(step['tools'])) {
        for (const entry of step['tools'] as string[]) {
          if (!/^[^:]+:[^:]+$/.test(entry)) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': tools entry '${entry}' must be in 'server_id:tool_name' format`,
              ),
            );
          }
        }
      }

      // issue #338: the check below only runs when an `mcp_servers` block EXISTS, so the absent-block
      // variant loaded clean — and every disclosure this loader has for tools lives inside that same
      // fork, so the corner produced no error, no warning, and a run where the declared tools were
      // simply never offered. ONE error per step, not one per entry: the entries are not individually
      // wrong, the workflow is.
      if (
        step['tools'] !== undefined &&
        Array.isArray(step['tools']) &&
        step['tools'].length > 0 &&
        !Array.isArray(doc['mcp_servers'])
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': declares tools but the workflow defines no mcp_servers — no drive ` +
              `can ever offer these tools, so the declaration can never be satisfied. Define an ` +
              `mcp_servers block, or remove 'tools'.`,
          ),
        );
      }

      // Validate tools: server_id must reference a defined mcp_server.
      if (
        step['tools'] !== undefined &&
        Array.isArray(step['tools']) &&
        Array.isArray(doc['mcp_servers'])
      ) {
        const serverIds = new Set((doc['mcp_servers'] as Array<{ id: string }>).map((s) => s.id));
        for (const entry of step['tools'] as string[]) {
          const serverId = entry.split(':')[0] ?? '';
          if (!serverIds.has(serverId)) {
            errors.push(
              withStepLine(
                stepName,
                `Step '${stepName}': tools entry '${entry}' references unknown MCP server '${serverId}'`,
              ),
            );
          }
        }
      }

      // Validate max_tool_calls: must be a positive integer.
      if (
        step['max_tool_calls'] !== undefined &&
        (!Number.isInteger(step['max_tool_calls']) || (step['max_tool_calls'] as number) <= 0)
      ) {
        errors.push(
          withStepLine(stepName, `Step '${stepName}': 'max_tool_calls' must be a positive integer`),
        );
      }

      // Validate max_fan_out: must be a positive integer.
      if (
        step['max_fan_out'] !== undefined &&
        (!Number.isInteger(step['max_fan_out']) || (step['max_fan_out'] as number) <= 0)
      ) {
        errors.push(
          withStepLine(stepName, `Step '${stepName}': 'max_fan_out' must be a positive integer`),
        );
      }

      // Validate tool_timeout: must be a positive integer. Skipped where the key is not valid at
      // all (issue #413's requires-tools check above already reported that) — the same convention
      // as `timeout_seconds` below: an author told BOTH that the key does not belong here and that
      // its value has the wrong shape is being pointed at the shape, which is not the problem.
      // The `!toolsMissing` complement is the SAME helper the prohibition keys on, so the two are
      // exhaustive and disjoint by construction: `tools: []` with a negative value reports once.
      if (
        step['tool_timeout'] !== undefined &&
        !toolsMissing &&
        (!Number.isInteger(step['tool_timeout']) || (step['tool_timeout'] as number) <= 0)
      ) {
        errors.push(
          withStepLine(stepName, `Step '${stepName}': 'tool_timeout' must be a positive integer`),
        );
      }

      // Validate timeout_seconds: must be a positive integer (issue A3). Skipped on
      // execution: guard — the guard-prohibited-fields check above already flatly rejects
      // 'timeout_seconds' there ('is not valid on execution: guard steps'); re-checking its
      // shape here would double-report the same root cause under a second, confusing message.
      // Same suppression for the agent prohibition (issue #402), for the same reason: an author
      // told BOTH that the key is invalid here and that its value has the wrong shape is being
      // pointed at the shape, which is not the problem.
      if (
        step['timeout_seconds'] !== undefined &&
        step['execution'] !== 'guard' &&
        step['execution'] !== 'agent' &&
        (!Number.isInteger(step['timeout_seconds']) || (step['timeout_seconds'] as number) <= 0)
      ) {
        errors.push(
          withStepLine(
            stepName,
            `Step '${stepName}': 'timeout_seconds' must be a positive integer`,
          ),
        );
      }
    }

    // Require at least one non-finalizer step: a workflow of only finalizers is meaningless
    // (nothing runs in the DAG, so it would seal immediately with no domain work).
    const stepEntries = Object.values(stepsRaw).filter(
      (s): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s),
    );
    if (stepEntries.length > 0 && stepEntries.every((s) => s['execution'] === 'finalizer')) {
      errors.push(
        `Workflow has only finalizer steps — at least one non-finalizer step is required ` +
          `(finalizers run at the terminal transition of the DAG's domain steps).`,
      );
    }

    // Reject depends_on cycles (issue #153): a transitive cycle among otherwise-valid edges is
    // loadable today (the per-step check above only validates one hop at a time), and at runtime
    // the cyclic steps are mutually ineligible forever — the run silently seals `completed` with
    // the stranded steps in NO step set and zero evidence. Build the graph over VALID edges only
    // (dep exists, isn't self, isn't a finalizer) — the self/unknown/finalizer-dep cases are
    // already reported by the per-step check above; a real cycle runs entirely through valid
    // edges, so excluding the already-errored ones here avoids double-reporting them.
    const dependencyEdges = new Map<string, string[]>();
    for (const stepName of Object.keys(stepsRaw)) {
      dependencyEdges.set(stepName, []);
    }
    for (const [stepName, stepRaw] of Object.entries(stepsRaw)) {
      if (typeof stepRaw !== 'object' || stepRaw === null || Array.isArray(stepRaw)) continue;
      const dependsOn = (stepRaw as Record<string, unknown>)['depends_on'];
      if (!Array.isArray(dependsOn)) continue;
      for (const dep of dependsOn) {
        if (
          typeof dep === 'string' &&
          dep !== stepName &&
          dep in stepsRaw &&
          (stepsRaw[dep] as Record<string, unknown>)['execution'] !== 'finalizer'
        ) {
          dependencyEdges.get(stepName)!.push(dep);
        }
      }
    }
    for (const cycle of detectDependencyCycles(dependencyEdges)) {
      errors.push(`Workflow has a dependency cycle: ${cycle.join(' → ')}`);
    }

    // Validate mcp_servers: ids must be unique (workflow-level check).
    if (Array.isArray(doc['mcp_servers'])) {
      const seen = new Set<string>();
      for (const server of doc['mcp_servers'] as Array<{ id: string }>) {
        if (seen.has(server.id)) {
          errors.push(`mcp_servers: duplicate server id '${server.id}'`);
        }
        seen.add(server.id);
      }
    }

    // Validate services: Ajv-strict entry schema (closed key set) + rate_limit fields.
    if (typeof doc['services'] === 'object' && doc['services'] !== null) {
      for (const [serviceName, serviceRaw] of Object.entries(
        doc['services'] as Record<string, unknown>,
      )) {
        if (typeof serviceRaw !== 'object' || serviceRaw === null) continue;
        const service = serviceRaw as Record<string, unknown>;

        // PERMANENT targeted rejection — must win over the generic unknown-key error.
        if ('auth' in service || 'token_from' in service) {
          errors.push(
            `Service '${serviceName}': 'auth.token_from' was removed in v0.14.0 — bind ` +
              `credentials in your deployment manifest (realm.yaml); see the migration note.`,
          );
        } else {
          const serviceAjv = new Ajv({ strict: true, allErrors: true });
          if (!serviceAjv.validate(SERVICE_ENTRY_JSON_SCHEMA, service)) {
            for (const err of serviceAjv.errors ?? []) {
              const detail =
                err.keyword === 'additionalProperties'
                  ? `unknown key '${String((err.params as { additionalProperty?: string }).additionalProperty)}'`
                  : `${err.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'entry'} ${err.message ?? 'invalid'}`;
              errors.push(`Service '${serviceName}': ${detail}`);
            }
          }
        }

        const rateLimit = service['rate_limit'];
        if (rateLimit === undefined) continue;
        if (typeof rateLimit !== 'object' || rateLimit === null) {
          errors.push(`Service '${serviceName}': 'rate_limit' must be an object`);
          continue;
        }
        const rl = rateLimit as Record<string, unknown>;

        if (
          'requests_per_second' in rl &&
          (!Number.isInteger(rl['requests_per_second']) ||
            (rl['requests_per_second'] as number) < 1)
        ) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.requests_per_second' must be a positive integer (≥ 1)`,
          );
        }
        if ('burst' in rl) {
          if (!Number.isInteger(rl['burst']) || (rl['burst'] as number) < 1) {
            errors.push(
              `Service '${serviceName}': 'rate_limit.burst' must be a positive integer (≥ 1)`,
            );
          }
          if (!('requests_per_second' in rl)) {
            errors.push(
              `Service '${serviceName}': 'rate_limit.burst' requires 'rate_limit.requests_per_second' to be set`,
            );
          }
        }
        if (
          'fallback_retry_seconds' in rl &&
          (typeof rl['fallback_retry_seconds'] !== 'number' ||
            (rl['fallback_retry_seconds'] as number) <= 0)
        ) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.fallback_retry_seconds' must be a positive number (> 0)`,
          );
        }
        if (
          'min_retry_seconds' in rl &&
          (typeof rl['min_retry_seconds'] !== 'number' || (rl['min_retry_seconds'] as number) <= 0)
        ) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.min_retry_seconds' must be a positive number (> 0)`,
          );
        }
        if (
          'max_retry_seconds' in rl &&
          (!Number.isInteger(rl['max_retry_seconds']) || (rl['max_retry_seconds'] as number) < 1)
        ) {
          errors.push(
            `Service '${serviceName}': 'rate_limit.max_retry_seconds' must be a positive integer (≥ 1)`,
          );
        }
      }
    }

    // Step 3b: Trigger block validation (schema-driven — see trigger-schema.ts)
    const triggerRaw = doc['trigger'];
    if (triggerRaw !== undefined) {
      normalizeTriggerFilter(triggerRaw); // canonicalise shorthand BEFORE validation
      errors.push(...validateTriggerStructure(triggerRaw));
    }

    if (errors.length > 0) {
      throw new WorkflowError(`Invalid workflow: ${errors.join('; ')}`, {
        // issue #425: the pre-join strings — see the profile collector above.
        errors: [...errors],
        code: 'VALIDATION_WORKFLOW_SCHEMA',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
      });
    }
    // Step 4: Stamp schema version and return typed result
    const definition = doc as unknown as WorkflowDefinition;
    definition.schema_version = CURRENT_WORKFLOW_SCHEMA_VERSION;
    return { definition, warnings };
  } catch (err) {
    if (err instanceof WorkflowError) attachLoaderWarnings(err, warnings);
    throw err;
  }
}

/** Returns true if any step in the raw steps map declares use_template. */
function hasUseTemplateInSteps(steps: unknown): boolean {
  if (typeof steps !== 'object' || steps === null) return false;
  return Object.values(steps as Record<string, unknown>).some(
    (s) => typeof s === 'object' && s !== null && 'use_template' in (s as object),
  );
}

/**
 * Recursively validates an input_map node tree.
 * Every object node must have at least one key.
 * Every leaf must be a non-empty string.
 * Maximum depth is 10.
 */
/**
 * Issue #287: the CLOSED set of input_map directives. The whole `$` prefix is reserved — a key
 * starting with `$` that is not in this set is a load error, which is what keeps the namespace
 * open for a future escape (e.g. key-doubling) without breaking anyone.
 */
const SUPPORTED_INPUT_MAP_DIRECTIVES = ['$literal'] as const;

function validateInputMapNode(
  node: unknown,
  pathDesc: string,
  errors: string[],
  depth: number,
): void {
  if (depth > 10) {
    errors.push(`${pathDesc}: exceeded maximum nesting depth of 10`);
    return;
  }
  if (typeof node === 'string') {
    if (node.trim() === '') {
      errors.push(`${pathDesc}: source path must be a non-empty string`);
    }
    return;
  }
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>;

    // Literal sentinel node.
    if ('$literal' in obj) {
      if (Object.keys(obj).length !== 1) {
        errors.push(
          `${pathDesc}: $literal node must have exactly one key ($literal); found sibling keys`,
        );
        return;
      }
      // The $literal value is passed through verbatim by the runtime — it may be any JSON value
      // (string, number, boolean, null, array, or object). Do NOT recurse into it: an object value
      // is a literal subtree, not a nested template. Return without further validation.
      return;
    }

    // issue #287 — the DIRECTIVE GATE. A `$`-prefixed key is unambiguous author intent: nobody
    // writes a nested-map key starting with `$` by accident. Before this gate, an unknown one was
    // accepted here, then resolved at runtime as a context PATH, yielding `undefined` — a param
    // that looked set and was not. That produced a five-week production incident in which an
    // Airtable query ran UNFILTERED and corrupted 907 records while every step reported success.
    //
    // The whole `$` prefix is reserved, not just the known names: erroring on `$$…` today is what
    // keeps a future key-doubling ESCAPE backward-compatible, so this must stay a prefix check
    // with no special cases. The wording says "supported directives:" rather than "the only
    // escape", for the same reason.
    //
    // Placed AFTER the `$literal` block so `{$literal, $unknown}` still reports the sibling error
    // first (that message names the more specific mistake), and BEFORE the nested-object
    // recursion so the key is judged here rather than descended into.
    for (const key of Object.keys(obj)) {
      if (!key.startsWith('$')) continue;
      const suggestion = closestKey(key, SUPPORTED_INPUT_MAP_DIRECTIVES);
      errors.push(
        `${pathDesc}: unknown directive '${key}' — supported directives: $literal.` +
          (suggestion !== undefined ? ` Did you mean '${suggestion}'?` : '') +
          ` To pass literal data containing $-keys, wrap the subtree in $literal.` +
          ` input_map values are context paths, nested maps, or $literal — templated strings are` +
          ` not supported.`,
      );
      return;
    }

    // Nested object — recurse.
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      errors.push(`${pathDesc}: object nodes must have at least one key`);
      return;
    }
    for (const [key, child] of entries) {
      validateInputMapNode(child, `${pathDesc} path "${key}"`, errors, depth + 1);
    }
    return;
  }
  // null, number, boolean, array
  errors.push(
    `${pathDesc}: expected a string or object, got ${Array.isArray(node) ? 'array' : typeof node}`,
  );
}
