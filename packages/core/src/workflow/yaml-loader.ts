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
): void {
  const split = splitComparison(leaf);

  if (split.kind === 'invalid') {
    if (split.reason === 'compound_and' || split.reason === 'compound_or') {
      const kw = split.reason === 'compound_and' ? 'and' : 'or';
      const listForm = (split.parts ?? [leaf]).map((p) => `    - "${p}"`).join('\n');
      errors.push(
        `Step '${stepName}': '${surface}' uses unsupported '${kw}' — write it as a list:\n` +
          `  ${surface}:\n${listForm}`,
      );
    } else if (split.reason === 'multiple_operators') {
      errors.push(
        `Step '${stepName}': '${surface}' leaf '${leaf}' has multiple comparison operators — each leaf must be a single comparison.`,
      );
    } else {
      errors.push(`Step '${stepName}': '${surface}' leaf must not be empty.`);
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
        `Step '${stepName}': precondition '${leaf}' must be a comparison (e.g. "step.field >= 1").`,
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
      validateSettlementReference(split.path, surface, leaf, stepName, dependsOn, errors);
      return;
    }
    if (!isPathShaped(split.path)) {
      errors.push(
        `Step '${stepName}': '${surface}' leaf '${leaf}' is not a valid path or comparison.`,
      );
      return;
    }
    if (surface === 'when') validateWhenReference(split.path, stepName, dependsOn, errors);
    return;
  }

  // comparison
  if (split.lhsPath.split('.')[0] === '$settlement') {
    validateSettlementReference(split.lhsPath, surface, leaf, stepName, dependsOn, errors);
    return;
  }
  if (!isPathShaped(split.lhsPath)) {
    errors.push(
      `Step '${stepName}': '${surface}' leaf '${leaf}' must have a path on the left-hand side (got '${split.lhsPath}').`,
    );
    return;
  }
  if (surface === 'when') validateWhenReference(split.lhsPath, stepName, dependsOn, errors);
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
      `Step '${stepName}': '${surface}' leaf '${leaf}' has an invalid '$settlement' reference ` +
        `'${path}' — expected '$settlement.<dep>.<field>'.`,
    );
    return;
  }
  // One-hop (§4c-S4): the SECOND segment must be a DIRECT dependency of this step.
  const dep = path.split('.')[1];
  if (dep === undefined) {
    errors.push(
      `Step '${stepName}': '${surface}' leaf '${leaf}' references '$settlement' with no ` +
        `dependency segment — expected '$settlement.<dep>.<field>' where '<dep>' is a direct dependency.`,
    );
    return;
  }
  if (!dependsOn.includes(dep)) {
    errors.push(
      `Step '${stepName}': '${surface}' references '$settlement.${dep}' — '${dep}' is not in ` +
        `its depends_on [${dependsOn.join(', ')}]. '$settlement' paths must reference a direct ` +
        `dependency (one-hop rule).`,
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
): void {
  const first = path.split('.')[0]!;
  if (first === 'run') {
    if (!(path === 'run.params' || path.startsWith('run.params.'))) {
      errors.push(
        `Step '${stepName}': 'when' references '${path}' — only 'run.params.*' is available from 'run'.`,
      );
    }
    return;
  }
  if (!dependsOn.includes(first)) {
    errors.push(
      `Step '${stepName}': 'when' references step '${first}' which is not in its depends_on [${dependsOn.join(', ')}]. Add it to depends_on or use 'run.params.*'.`,
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
  let raw: unknown;
  try {
    raw = load(content);
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
      errors.push(`Step '${stepName}' must be an object`);
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
        errors.push(`Step '${stepName}': missing required field '${field}'`);
      }
    }

    if ('execution' in step && !VALID_EXECUTIONS.has(step['execution'] as string)) {
      errors.push(
        `Step '${stepName}': invalid execution value '${String(step['execution'])}'; must be 'auto', 'agent', 'guard', or 'finalizer'`,
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
          errors.push(`Step '${stepName}': '${field}' is not valid on execution: finalizer steps`);
        }
      }
      // A finalizer must not gate — reject any human-gate trust level.
      if (step['trust'] !== undefined && step['trust'] !== 'auto') {
        errors.push(
          `Step '${stepName}': 'trust: ${String(step['trust'])}' is not valid on execution: finalizer steps (a finalizer must not gate)`,
        );
      }
      // v1 is handler-only.
      if (step['handler'] === undefined) {
        errors.push(
          `Step '${stepName}': execution: finalizer requires 'handler' (handler-only in v1)`,
        );
      }
      // on_outcome is required, non-empty, every value in the FinalizerTrigger enum.
      const rawOutcome = step['on_outcome'];
      if (rawOutcome === undefined) {
        errors.push(`Step '${stepName}': execution: finalizer requires 'on_outcome'`);
      } else {
        const outcomes = Array.isArray(rawOutcome) ? rawOutcome : [rawOutcome];
        if (outcomes.length === 0) {
          errors.push(`Step '${stepName}': 'on_outcome' must not be empty`);
        }
        for (const o of outcomes) {
          if (typeof o !== 'string' || !VALID_FINALIZER_TRIGGERS.has(o)) {
            errors.push(
              `Step '${stepName}': invalid on_outcome value '${String(o)}'; must be one of ${[...VALID_FINALIZER_TRIGGERS].join(', ')}`,
            );
          }
        }
      }
    }

    // on_outcome is only valid on execution: finalizer steps.
    if (step['on_outcome'] !== undefined && step['execution'] !== 'finalizer') {
      errors.push(`Step '${stepName}': 'on_outcome' is only valid on execution: finalizer steps`);
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
          errors.push(`Step '${stepName}': '${field}' is not valid on execution: guard steps`);
        }
      }
      if (step['abort_unless'] === undefined) {
        errors.push(`Step '${stepName}': execution: guard requires 'abort_unless'`);
      }
    }

    // abort_unless and abort_message are only valid on execution: guard steps.
    if (step['abort_unless'] !== undefined && step['execution'] !== 'guard') {
      errors.push(`Step '${stepName}': 'abort_unless' is only valid on execution: guard steps`);
    }
    if (step['abort_message'] !== undefined && step['execution'] !== 'guard') {
      errors.push(`Step '${stepName}': 'abort_message' is only valid on execution: guard steps`);
    }

    // agent_profile is only valid on agent steps.
    if ('agent_profile' in step && step['execution'] !== 'agent') {
      errors.push(`Step '${stepName}': 'agent_profile' is only valid on execution: agent steps`);
    }

    // idempotent (issue #101 Phase 2) is only valid on execution: auto steps — the reliably
    // time-boundable, deadline-carrying class. It is inert (no concrete deadline is ever written)
    // on agent/guard/finalizer, so it is rejected there rather than silently ignored.
    if (step['idempotent'] !== undefined && step['execution'] !== 'auto') {
      errors.push(`Step '${stepName}': 'idempotent' is only valid on execution: auto steps`);
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
      errors.push(`Step '${stepName}': 'output_schema' is only valid on execution: agent steps`);
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
          `Step '${stepName}': 'structured_output' is only valid on execution: agent steps`,
        );
      } else if (step['structured_output'] !== 'strict') {
        errors.push(
          `Step '${stepName}': 'structured_output' must be the literal string 'strict' (got ${JSON.stringify(step['structured_output'])})`,
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
            `Step '${stepName}': 'structured_output: strict' is not eligible for this step's ` +
              `schema — ${renderIneligibleMessage(verdict.reasons)}`,
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
          `Step '${stepName}': 'validation_exhaustion' is only valid on execution: agent steps`,
        );
      } else if (
        typeof step['validation_exhaustion'] !== 'object' ||
        step['validation_exhaustion'] === null
      ) {
        errors.push(`Step '${stepName}': 'validation_exhaustion' must be an object`);
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
          }),
        );

        if (
          'threshold' in exhaustionBlock &&
          (!Number.isInteger(exhaustionBlock['threshold']) ||
            (exhaustionBlock['threshold'] as number) < 1)
        ) {
          errors.push(
            `Step '${stepName}': 'validation_exhaustion.threshold' must be a positive integer ` +
              `(1 is legal — it disables in-drive schema-repair, since the first rejection ` +
              `already meets it)`,
          );
        }

        const modeValue = exhaustionBlock['mode'];
        if (modeValue !== undefined && modeValue !== 'fail' && modeValue !== 'default') {
          errors.push(
            `Step '${stepName}': 'validation_exhaustion.mode' must be 'fail' or 'default' ` +
              `(got: ${JSON.stringify(modeValue)})`,
          );
        }

        const hasDefaultOutput = 'default_output' in exhaustionBlock;
        if (modeValue === 'default') {
          if (!hasDefaultOutput) {
            errors.push(
              `Step '${stepName}': 'validation_exhaustion.mode: default' requires ` +
                `'default_output' (nothing to substitute on exhaustion)`,
            );
          } else if (step['output_schema'] === undefined) {
            errors.push(
              `Step '${stepName}': 'validation_exhaustion.default_output' requires the step to ` +
                `declare 'output_schema' (an undeclared schema makes the default unvalidatable)`,
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
                `Step '${stepName}': 'validation_exhaustion.default_output' does not validate ` +
                  `against the step's own 'output_schema': ${detail}`,
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
      errors.push(`Step '${stepName}': 'trace_schema' is only valid on execution: agent steps`);
    }

    // trace_validation_mode is only valid on execution: agent steps.
    if (step['trace_validation_mode'] !== undefined && step['execution'] !== 'agent') {
      errors.push(
        `Step '${stepName}': 'trace_validation_mode' is only valid on execution: agent steps`,
      );
    }

    // trace_validation_mode must be 'warn' or 'enforce' when provided.
    if (
      step['trace_validation_mode'] !== undefined &&
      step['trace_validation_mode'] !== 'warn' &&
      step['trace_validation_mode'] !== 'enforce'
    ) {
      errors.push(
        `Step '${stepName}': invalid trace_validation_mode '${String(step['trace_validation_mode'])}'; must be 'warn' or 'enforce'`,
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
        errors.push(`Step '${stepName}': 'gate' must be an object`);
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
          }),
        );

        // E2: timeout_seconds/reminder_seconds/reminder_max must each be a positive integer
        // (yaml-loader :1164-1174 precedent — the SAME convention as retry.total_timeout_seconds).
        if (
          'timeout_seconds' in gate &&
          (!Number.isInteger(gate['timeout_seconds']) || (gate['timeout_seconds'] as number) <= 0)
        ) {
          errors.push(`Step '${stepName}': 'gate.timeout_seconds' must be a positive integer`);
        }
        if (
          'reminder_seconds' in gate &&
          (!Number.isInteger(gate['reminder_seconds']) || (gate['reminder_seconds'] as number) <= 0)
        ) {
          errors.push(`Step '${stepName}': 'gate.reminder_seconds' must be a positive integer`);
        }
        if (
          'reminder_max' in gate &&
          (!Number.isInteger(gate['reminder_max']) || (gate['reminder_max'] as number) <= 0)
        ) {
          errors.push(`Step '${stepName}': 'gate.reminder_max' must be a positive integer`);
        }

        // on_expiry must be 'settle_default' or 'abort' when provided.
        const onExpiry = gate['on_expiry'];
        if (onExpiry !== undefined && onExpiry !== 'settle_default' && onExpiry !== 'abort') {
          errors.push(
            `Step '${stepName}': 'gate.on_expiry' must be 'settle_default' or 'abort' (got: ${JSON.stringify(onExpiry)})`,
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
              `Step '${stepName}': 'gate.on_expiry: settle_default' requires 'gate.default_choice' ` +
                `(nothing to resolve the gate with on expiry)`,
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
                `Step '${stepName}': 'gate.default_choice' (${JSON.stringify(gate['default_choice'])}) ` +
                  `is not one of the step's effective choices: ${effectiveChoices.join(', ')}`,
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
          `Step '${stepName}': uses_service '${step['uses_service']}' is not defined in 'services'`,
        );
      }
    }

    // Validate retry: backoff must be a recognised value when present.
    if (step['retry'] !== undefined) {
      if (typeof step['retry'] !== 'object' || step['retry'] === null) {
        errors.push(`Step '${stepName}': 'retry' must be an object`);
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
          }),
        );

        if (
          'backoff' in retry &&
          retry['backoff'] !== 'fixed' &&
          retry['backoff'] !== 'linear' &&
          retry['backoff'] !== 'exponential'
        ) {
          errors.push(
            `Step '${stepName}': 'retry.backoff' must be 'fixed', 'linear', or 'exponential'`,
          );
        }
        if (
          'max_attempts' in retry &&
          (!Number.isInteger(retry['max_attempts']) || (retry['max_attempts'] as number) < 1)
        ) {
          errors.push(`Step '${stepName}': 'retry.max_attempts' must be a positive integer`);
        }
        if (
          'base_delay_ms' in retry &&
          (typeof retry['base_delay_ms'] !== 'number' || (retry['base_delay_ms'] as number) < 0)
        ) {
          errors.push(`Step '${stepName}': 'retry.base_delay_ms' must be a non-negative number`);
        }
        if (
          'max_delay_ms' in retry &&
          (typeof retry['max_delay_ms'] !== 'number' || (retry['max_delay_ms'] as number) < 0)
        ) {
          errors.push(`Step '${stepName}': 'retry.max_delay_ms' must be a non-negative number`);
        }

        // --- issue #140: on_timeout / total_timeout_seconds --------------------------------

        // E3: on_timeout must be a boolean (kills the 'on_timeout: "true"' silent-inert case).
        if ('on_timeout' in retry && typeof retry['on_timeout'] !== 'boolean') {
          errors.push(`Step '${stepName}': 'retry.on_timeout' must be a boolean`);
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
            `Step '${stepName}': 'retry.total_timeout_seconds' must be a positive integer`,
          );
        }

        // E1: on_timeout: true requires idempotent: true — declared, never inferred. Strict
        // `=== true` on both loci, provably matching the engine's own conjunct.
        if (retry['on_timeout'] === true && step['idempotent'] !== true) {
          errors.push(
            `Step '${stepName}': 'retry.on_timeout: true' requires 'idempotent: true' declared ` +
              `on the step — a timeout-retry can run concurrently with the still-in-flight ` +
              `original attempt, so the step must explicitly attest that any partial prior ` +
              `application is harmless to re-apply. Declare 'idempotent: true' or remove ` +
              `'on_timeout'.`,
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

    if ('service_method' in step && !VALID_SERVICE_METHODS.has(step['service_method'] as string)) {
      errors.push(
        `Step '${stepName}': invalid service_method '${String(step['service_method'])}'; must be 'fetch', 'create', 'update', or 'delete'`,
      );
    }

    // Validate input_map: only valid on execution: auto steps (both uses_service and handler).
    if (step['input_map'] !== undefined) {
      if (step['execution'] !== 'auto') {
        errors.push(`Step '${stepName}': 'input_map' is only valid on execution: auto steps`);
      } else {
        validateInputMapNode(
          step['input_map'] as Record<string, unknown>,
          `Step '${stepName}': input_map`,
          errors,
          0,
        );
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
          `Step '${stepName}': 'config' declared but adapter '${adapterName}' does not declare 'config_schema'`,
        );
      } else if (adapter?.config_schema !== undefined) {
        const ajv = new Ajv();
        const valid = ajv.validate(adapter.config_schema as object, step['config']);
        if (!valid) {
          const errMessages = ajv.errors?.map((e) => e.message ?? '').join('; ') ?? 'unknown error';
          errors.push(
            `Step '${stepName}': config validation failed against adapter config_schema: ${errMessages}`,
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
              `Step '${stepName}': handler '${handlerName}' declares uses_resources '${resourceStepId}' ` +
                `but no step with that ID exists in this workflow`,
            );
          }
        }
      }
    }

    // Validate trigger_rule.
    if ('trigger_rule' in step) {
      if (!VALID_TRIGGER_RULES.has(step['trigger_rule'] as TriggerRule)) {
        errors.push(
          `Step '${stepName}': invalid trigger_rule '${String(step['trigger_rule'])}'; must be one of ${[...VALID_TRIGGER_RULES].join(', ')}`,
        );
      }
    }

    // Validate depends_on: must be an array of existing step names.
    if ('depends_on' in step && step['depends_on'] !== undefined) {
      if (!Array.isArray(step['depends_on'])) {
        errors.push(`Step '${stepName}': 'depends_on' must be an array`);
      } else {
        for (const dep of step['depends_on'] as unknown[]) {
          if (typeof dep !== 'string') {
            errors.push(`Step '${stepName}': depends_on entries must be strings`);
          } else if (dep === stepName) {
            errors.push(`Step '${stepName}': a step cannot depend on itself`);
          } else if (!(dep in stepsRaw)) {
            errors.push(`Step '${stepName}': depends_on references unknown step '${dep}'`);
          } else if ((stepsRaw[dep] as Record<string, unknown>)['execution'] === 'finalizer') {
            // A domain step depending on a held-out finalizer would deadlock: the finalizer
            // never enters the eligible set, so this step never becomes eligible and the run
            // never seals.
            errors.push(
              `Step '${stepName}': depends_on references finalizer step '${dep}' — finalizers ` +
                `run at the terminal transition and are held out of the DAG; a step cannot depend on one.`,
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
          errors.push(`Step '${stepName}': 'when' must be a non-empty string`);
        } else {
          validateConditionLeaf('when', rawWhen, stepName, dependsOn, errors);
        }
      } else if (Array.isArray(rawWhen)) {
        if (rawWhen.length === 0) {
          errors.push(`Step '${stepName}': 'when' array must not be empty`);
        } else {
          for (const leaf of rawWhen) {
            if (typeof leaf !== 'string' || leaf.trim() === '') {
              errors.push(`Step '${stepName}': 'when' array entries must be non-empty strings`);
            } else {
              validateConditionLeaf('when', leaf, stepName, dependsOn, errors);
            }
          }
        }
      } else {
        errors.push(`Step '${stepName}': 'when' must be a string or an array of strings`);
      }
    }

    // Validate abort_unless leaf shape (guard steps only; the LEGACY depends_on/run.params
    // reference check is when-only — but issue #220 §4c's `$settlement` one-hop check fires here
    // too, via the hoisted `dependsOn`, SCOPED to `$settlement.`-prefixed paths only).
    if (step['abort_unless'] !== undefined && step['execution'] === 'guard') {
      const rawAbort = step['abort_unless'];
      if (typeof rawAbort === 'string') {
        if (rawAbort.trim() === '') {
          errors.push(`Step '${stepName}': 'abort_unless' must be a non-empty string`);
        } else {
          validateConditionLeaf('abort_unless', rawAbort, stepName, dependsOn, errors);
        }
      } else if (Array.isArray(rawAbort)) {
        if (rawAbort.length === 0) {
          errors.push(`Step '${stepName}': 'abort_unless' array must not be empty`);
        } else {
          for (const leaf of rawAbort) {
            if (typeof leaf !== 'string' || leaf.trim() === '') {
              errors.push(
                `Step '${stepName}': 'abort_unless' array entries must be non-empty strings`,
              );
            } else {
              validateConditionLeaf('abort_unless', leaf, stepName, dependsOn, errors);
            }
          }
        }
      } else {
        errors.push(`Step '${stepName}': 'abort_unless' must be a string or an array of strings`);
      }
    }

    // Validate preconditions leaf shape (each must be a single comparison). Reference check is
    // `$settlement`-scoped only (issue #220 §4c) — a non-`$settlement` precondition has no
    // depends_on/run.params check (unchanged from before this PR).
    if (step['preconditions'] !== undefined) {
      const rawPre = step['preconditions'];
      if (!Array.isArray(rawPre)) {
        errors.push(`Step '${stepName}': 'preconditions' must be an array of strings`);
      } else {
        for (const leaf of rawPre) {
          if (typeof leaf !== 'string' || leaf.trim() === '') {
            errors.push(`Step '${stepName}': 'preconditions' entries must be non-empty strings`);
          } else {
            validateConditionLeaf('preconditions', leaf, stepName, dependsOn, errors);
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
          if (segments.length !== 3 || segments[0] !== '$settlement' || segments[2] !== 'failed') {
            continue;
          }
          const dep = segments[1]!;
          // Without the dep actually being a dependency, the one-hop error fires on its own AND
          // the trigger gate returns true unconditionally for a step with no deps — so the leaf
          // is not dead-by-trigger here and the remedy would be false advice.
          if (!dependsOn.includes(dep)) continue;

          const ruleText = ruleDeclared ? `'${rule}'` : `the default '${rule}'`;
          const consequence =
            surface === 'when'
              ? `if '${dep}' fails the step is skipped as trigger_rule_unsatisfiable before the condition is evaluated; if '${dep}' succeeds the condition evaluates to false (when_false) — either way the step never runs`
              : surface === 'preconditions'
                ? `the step never settles — the run WEDGES in a blocked envelope`
                : `the guard aborts the run on every execution`;

          if (step['execution'] === 'guard') {
            // Guards cannot declare a trigger rule, so the trigger-rule remedy is wrong advice
            // here. This is a v1 SCOPE narrowing, not an architectural statement — issue #366
            // carries the design question.
            errors.push(
              `Step '${stepName}': '${surface}' condition "${leaf}" can never be true — a guard runs ` +
                `under ${ruleText} and 'trigger_rule' is not a valid field on execution: guard steps, ` +
                `so '${dep}' has always succeeded by the time this is evaluated (${consequence}). ` +
                `Guards run only when their dependencies succeeded; for work that must happen AFTER a ` +
                `failure, use an 'execution: finalizer' step (see issue #366 for widening guards).`,
            );
          } else {
            const remedies = ['all_done', 'one_failed'];
            if (new Set(dependsOn).size === 1) remedies.push('all_failed');
            const tail =
              new Set(dependsOn).size > 1
                ? ` ('all_failed' fires only if EVERY dependency fails; 'one_success' only if at least one other dependency succeeds.)`
                : '';
            errors.push(
              `Step '${stepName}': '${surface}' condition "${leaf}" can never be true — under ` +
                `${ruleText} trigger rule, '${dep}' can never be in failed_steps when this step is ` +
                `evaluated (${consequence}). To run this step when '${dep}' fails, set trigger_rule to ` +
                `one of: ${remedies.join(', ')}.${tail}`,
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
        `Step '${stepName}': 'tools' is only valid on execution: agent steps without 'handler' defined`,
      );
    }

    // Validate tools: requires input_schema.
    if (step['tools'] !== undefined && step['input_schema'] === undefined) {
      errors.push(
        `Step '${stepName}': 'tools' requires 'input_schema' to be defined — the agentic loop needs a schema for final output extraction`,
      );
    }

    // Validate tools: entries must be in server_id:tool_name format.
    if (step['tools'] !== undefined && Array.isArray(step['tools'])) {
      for (const entry of step['tools'] as string[]) {
        if (!/^[^:]+:[^:]+$/.test(entry)) {
          errors.push(
            `Step '${stepName}': tools entry '${entry}' must be in 'server_id:tool_name' format`,
          );
        }
      }
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
            `Step '${stepName}': tools entry '${entry}' references unknown MCP server '${serverId}'`,
          );
        }
      }
    }

    // Validate max_tool_calls: must be a positive integer.
    if (
      step['max_tool_calls'] !== undefined &&
      (!Number.isInteger(step['max_tool_calls']) || (step['max_tool_calls'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'max_tool_calls' must be a positive integer`);
    }

    // Validate max_fan_out: must be a positive integer.
    if (
      step['max_fan_out'] !== undefined &&
      (!Number.isInteger(step['max_fan_out']) || (step['max_fan_out'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'max_fan_out' must be a positive integer`);
    }

    // Validate tool_timeout: must be a positive integer.
    if (
      step['tool_timeout'] !== undefined &&
      (!Number.isInteger(step['tool_timeout']) || (step['tool_timeout'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'tool_timeout' must be a positive integer`);
    }

    // Validate timeout_seconds: must be a positive integer (issue A3). Skipped on
    // execution: guard — the guard-prohibited-fields check above already flatly rejects
    // 'timeout_seconds' there ('is not valid on execution: guard steps'); re-checking its
    // shape here would double-report the same root cause under a second, confusing message.
    if (
      step['timeout_seconds'] !== undefined &&
      step['execution'] !== 'guard' &&
      (!Number.isInteger(step['timeout_seconds']) || (step['timeout_seconds'] as number) <= 0)
    ) {
      errors.push(`Step '${stepName}': 'timeout_seconds' must be a positive integer`);
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
        (!Number.isInteger(rl['requests_per_second']) || (rl['requests_per_second'] as number) < 1)
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
